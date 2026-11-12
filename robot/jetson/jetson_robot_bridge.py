#!/usr/bin/env python3
"""
Puente Jetson Orin Nano  <->  ESP32  <->  Dashboard (vía rosbridge)

Implementa el diagrama de flujo del robot:
  NORMAL  : el dashboard manda latidos (/dashboard_heartbeat). Modo manual o automático.
  RTH     : si pasan más de 5 s sin latidos, el robot regresa solo a la base (por el camino recorrido).
  ESPERA  : llegó a la base (o no puede moverse): detenido hasta que el operador elija un modo.

Entradas (desde el dashboard):
  /dashboard_heartbeat std_msgs/Bool               latido, 2 por segundo
  /cmd_vel             geometry_msgs/Twist         conducción manual
  /robot_mode          std_msgs/String             "manual" | "automatico"
  /estop               std_msgs/Bool               parada de emergencia (también cancela el retorno)
  /arm_cmd             std_msgs/Float32MultiArray  [base, hombro, codo, muñeca] en grados (-90..90)
  /gripper_cmd         std_msgs/Float32            0 (cerrada) .. 100 (abierta)
  /scan                sensor_msgs/LaserScan       LiDAR Oradar MS200

Salidas (hacia el dashboard):
  /sensores          std_msgs/String (JSON)        temp, hum, pres, co, ch4, o2, h2s, bat, bat_v, inc, rumbo, alerta
  /robot_mode_state  std_msgs/String               "MANUAL" | "AUTOMATICO" (modo real del ESP32)
  /robot_status      std_msgs/String (JSON)        estado, perdida, puntos, x, y
  /arm_state         std_msgs/Float32MultiArray
  /gripper_state     std_msgs/Float32MultiArray    [posición %, 0]

El origen (0, 0) de la odometría es donde estaba el robot al arrancar este nodo: esa es "la base".
"""
import json
import math
import time

import rclpy
import serial
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import LaserScan
from std_msgs.msg import Bool, Float32, Float32MultiArray, String

try:
    from .cloud_gateway import CloudGateway
except ImportError:                      # ejecutado como script suelto
    from cloud_gateway import CloudGateway


def norm_ang(a: float) -> float:
    return math.atan2(math.sin(a), math.cos(a))


class JetsonRobotBridge(Node):
    def __init__(self):
        super().__init__('jetson_robot_bridge')

        p = self.declare_parameter
        self.port = p('serial_port', '/dev/ttyTHS1').value
        self.baud = p('baud_rate', 115200).value
        # LiDAR y evasión
        self.front_offset = p('front_offset_deg', 0.0).value     # giro del LiDAR respecto al frente
        self.front_half = p('front_half_angle_deg', 30.0).value
        self.side_angle = p('side_angle_deg', 90.0).value
        self.obstacle_dist = p('obstacle_dist', 0.5).value       # m
        # Velocidades (PWM 0..255)
        self.auto_speed = p('auto_speed', 150).value
        self.turn_speed = p('turn_speed', 120).value
        self.rth_speed = p('rth_speed', 140).value
        self.max_lin = p('max_lin_speed', 0.6).value             # m/s que equivalen a PWM máximo
        self.max_ang = p('max_ang_speed', 1.2).value             # rad/s que equivalen a PWM máximo
        self.max_pwm = p('max_pwm', 255).value
        self.min_pwm = p('min_pwm', 70).value
        # Odometría y retorno
        self.ticks_por_m = p('ticks_por_metro', 1000.0).value    # CALIBRAR: ticks de ambas ruedas por metro
        self.crumb_step = p('crumb_step_m', 0.25).value
        self.reach = p('reach_m', 0.30).value
        self.heading_tol = p('heading_tol_deg', 25.0).value
        self.steer_gain = p('steer_gain', 120.0).value
        # Señal de la estación base
        self.hb_timeout = p('hb_timeout_s', 1.5).value           # sin latido por más de esto = sin señal
        self.rth_after = p('rth_after_s', 5.0).value             # el diagrama: "¿> 5 s?"
        # Pasarela a la nube (panel web en Vercel). Vacío = desactivada.
        self.cloud_url = p('cloud_url', '').value                # p. ej. https://tu-proyecto.vercel.app
        self.cloud_key = p('cloud_key', '').value                # = clave pyx_... del robot (panel → Administración → Robots)
        self.cloud_push = p('cloud_push_s', 1.0).value
        self.cloud_poll = p('cloud_poll_s', 0.25).value

        self.ser = None
        self.ultimo_intento = 0.0
        self.modo = 'MANUAL'           # modo real, informado por el ESP32
        self.alerta_prev = 0
        self.pts = []                  # (ángulo_deg respecto al frente, distancia)
        self.range_max = 10.0
        self.scan_t = 0.0
        self.giro = None
        # Estado del diagrama
        self.estado = 'NORMAL'
        self.last_hb = time.monotonic()
        self.t_modo_cmd = 0.0
        # Odometría
        self.x = self.y = self.theta = 0.0
        self.rumbo0 = None
        self.enc_prev = None
        self.crumbs = [(0.0, 0.0)]
        # Publicación limitada
        self.t_pub = 0.0
        self.n_tick = 0
        self.ultimo_dato = {}
        self.arm_real = None
        self.grip_real = None
        self.cloud = None
        self.drive_nube = False

        self.abrir_serial()

        self.pub_sensores = self.create_publisher(String, '/sensores', 10)
        self.pub_modo = self.create_publisher(String, '/robot_mode_state', 10)
        self.pub_status = self.create_publisher(String, '/robot_status', 10)
        self.pub_arm = self.create_publisher(Float32MultiArray, '/arm_state', 10)
        self.pub_grip = self.create_publisher(Float32MultiArray, '/gripper_state', 10)

        self.create_subscription(LaserScan, '/scan', self.scan_cb, qos_profile_sensor_data)
        self.create_subscription(Bool, '/dashboard_heartbeat', self.hb_cb, 10)
        self.create_subscription(Twist, '/cmd_vel', self.cmd_vel_cb, 10)
        self.create_subscription(String, '/robot_mode', self.modo_cb, 10)
        self.create_subscription(Bool, '/estop', self.estop_cb, 10)
        self.create_subscription(Float32MultiArray, '/arm_cmd', self.arm_cb, 10)
        self.create_subscription(Float32, '/gripper_cmd', self.grip_cb, 10)

        self.create_timer(0.02, self.serial_read)
        self.create_timer(0.1, self.tick)
        if self.cloud_url and self.cloud_key:
            self.cloud = CloudGateway(self.cloud_url, self.cloud_key, self.cloud_push, self.cloud_poll,
                                      snapshot=self.telemetria_nube, log=lambda m: self.get_logger().info(m))
            self.cloud.iniciar()
            self.create_timer(0.05, self.aplicar_ordenes)
            self.get_logger().info(f'Pasarela a la nube activa: {self.cloud_url}')
        self.get_logger().info('Puente Jetson iniciado')

    # ---------- Serial ----------
    def abrir_serial(self):
        self.ultimo_intento = time.monotonic()
        try:
            self.ser = serial.Serial(self.port, self.baud, timeout=0.05)
            self.get_logger().info(f'Conectado al ESP32 en {self.port}')
        except Exception as e:
            self.ser = None
            self.get_logger().error(f'No se pudo abrir {self.port}: {e}', throttle_duration_sec=5.0)

    def cerrar_serial(self):
        try:
            if self.ser:
                self.ser.close()
        except Exception:
            pass
        self.ser = None

    def enviar(self, cmd: str):
        """Los comandos al ESP32 llevan '#' delante (comparten UART0 con el teclado)."""
        if not self.ser:
            return
        try:
            self.ser.write(('#' + cmd + '\n').encode('utf-8'))
        except (serial.SerialException, OSError):
            self.get_logger().error('Se perdió la conexión serial con el ESP32')
            self.cerrar_serial()

    def serial_read(self):
        if self.ser is None:
            if time.monotonic() - self.ultimo_intento > 2.0:
                self.abrir_serial()
            return
        try:
            while self.ser.in_waiting:
                linea = self.ser.readline().decode('utf-8', errors='ignore').strip()
                if linea:
                    self.procesar_linea(linea)
        except (serial.SerialException, OSError):
            self.get_logger().error('Se perdió la conexión serial con el ESP32')
            self.cerrar_serial()

    def procesar_linea(self, linea: str):
        if not (linea.startswith('{') and linea.endswith('}')):
            return      # mensajes de texto del ESP32 (menú, avisos): se ignoran
        try:
            d = json.loads(linea)
        except json.JSONDecodeError:
            return

        self.actualizar_odometria(d)

        modo = d.get('MODO', 'MANUAL')
        alerta = int(d.get('ALERTA', 0))
        cambio = (modo != self.modo) or (alerta != self.alerta_prev)
        if alerta and not self.alerta_prev:
            self.get_logger().error('ALERTA del ESP32: parada por gas o temperatura alta')
        self.modo = modo
        self.alerta_prev = alerta
        if modo != 'AUTOMATICO':
            self.giro = None

        ahora = time.monotonic()
        if not cambio and ahora - self.t_pub < 0.5:
            return
        self.t_pub = ahora
        self.pub_modo.publish(String(data=modo))

        roll, pitch = d.get('ROLL'), d.get('PITCH')
        inc = max(abs(roll), abs(pitch)) if roll is not None and pitch is not None else None
        datos = {
            'temp': d.get('TEMP'), 'hum': d.get('HUM'), 'pres': d.get('PRES'),
            'co': d.get('CO'), 'co_raw': d.get('CO_RAW'),
            'inc': inc, 'rumbo': d.get('RUMBO'), 'alerta': alerta,
            'ch4': d.get('CH4'), 'o2': d.get('O2'), 'h2s': d.get('H2S'), 'bat': d.get('BAT'), 'bat_v': d.get('BAT_V'),
        }
        self.ultimo_dato = datos
        self.pub_sensores.publish(String(data=json.dumps(datos)))
        if isinstance(d.get('ARM'), list):
            self.arm_real = [float(x) for x in d['ARM']]
            self.pub_arm.publish(Float32MultiArray(data=[float(x) for x in d['ARM']]))
        if d.get('GRIP') is not None:
            self.grip_real = float(d['GRIP'])
            self.pub_grip.publish(Float32MultiArray(data=[float(d['GRIP']), 0.0]))

    # ---------- Odometría y camino recorrido ----------
    def actualizar_odometria(self, d: dict):
        enc, rumbo = d.get('ENC'), d.get('RUMBO')
        if not isinstance(enc, list) or len(enc) != 2 or rumbo is None:
            return
        if self.rumbo0 is None:
            self.rumbo0, self.enc_prev = rumbo, enc
            return
        # El BNO055 mide el rumbo en sentido horario; en ROS el giro antihorario es positivo
        self.theta = norm_ang(-math.radians(rumbo - self.rumbo0))
        dist = ((enc[0] - self.enc_prev[0]) + (enc[1] - self.enc_prev[1])) / 2.0 / self.ticks_por_m
        self.enc_prev = enc
        self.x += dist * math.cos(self.theta)
        self.y += dist * math.sin(self.theta)

        ux, uy = self.crumbs[-1]
        if math.hypot(self.x - ux, self.y - uy) >= self.crumb_step:
            # si el robot vuelve por donde ya pasó, se borra el lazo
            for i, (cx, cy) in enumerate(self.crumbs[:-4]):
                if math.hypot(self.x - cx, self.y - cy) < self.crumb_step * 0.8:
                    del self.crumbs[i + 1:]
                    break
            self.crumbs.append((self.x, self.y))
            if len(self.crumbs) > 4000:
                self.crumbs = self.crumbs[:1] + self.crumbs[1::2]

    # ---------- Comandos del dashboard ----------
    def senal(self) -> bool:
        return time.monotonic() - self.last_hb < self.hb_timeout

    def hb_cb(self, m: Bool):
        self.last_hb = time.monotonic()

    def a_pwm(self, v: float) -> int:
        v = max(-1.0, min(1.0, v))
        pwm = int(round(abs(v) * self.max_pwm))
        if pwm == 0:
            return 0
        pwm = max(pwm, self.min_pwm)
        return pwm if v > 0 else -pwm

    def cmd_vel_cb(self, m: Twist):
        if self.estado != 'NORMAL':
            return
        ln = m.linear.x / self.max_lin
        an = m.angular.z / self.max_ang      # +z = giro a la izquierda
        self.enviar(f'DRV:{self.a_pwm(ln - an)},{self.a_pwm(ln + an)}')

    def modo_cb(self, m: String):
        if self.estado == 'RTH':
            self.get_logger().warn('Retorno a base en curso: use la parada de emergencia para cancelarlo',
                                   throttle_duration_sec=2.0)
            return
        if self.estado == 'ESPERA':
            if not self.senal():
                return
            self.estado = 'NORMAL'
            self.get_logger().info('Operador retomó el control')
        self.enviar('MODE:AUTO' if m.data.lower().startswith('auto') else 'MODE:MANUAL')

    def estop_cb(self, m: Bool):
        if not m.data:
            return
        self.enviar('STOP')
        self.giro = None
        self.estado = 'NORMAL' if self.senal() else 'ESPERA'
        self.get_logger().warn('PARADA DE EMERGENCIA desde el dashboard')

    def arm_cb(self, m: Float32MultiArray):
        if len(m.data) >= 3:   # 4 valores con muñeca; 3 valores sigue siendo válido
            a = [max(-90.0, min(90.0, x)) for x in m.data[:4]]
            self.enviar('ARM:' + ','.join(f'{x:.0f}' for x in a))

    def grip_cb(self, m: Float32):
        self.enviar(f'GRIP:{max(0.0, min(100.0, m.data)):.0f}')

    # ---------- Nube ----------
    def lidar_72(self):
        """72 sectores de 5° en cm; el 0 es el frente y se avanza en sentido horario. 0 = sin lectura."""
        if time.monotonic() - self.scan_t > 2.0 or not self.pts:
            return None
        sec = [0] * 72
        for a, r in self.pts:
            i = int(((-a) % 360.0) // 5.0) % 72
            cm = int(round(r * 100))
            if sec[i] == 0 or cm < sec[i]:
                sec[i] = cm
        return sec

    def telemetria_nube(self):
        # Se ejecuta en el hilo de la pasarela: solo lee atributos (lecturas atómicas), no toca ROS.
        d = dict(self.ultimo_dato or {})
        t = {k: d.get(k) for k in ('co', 'ch4', 'o2', 'h2s', 'temp', 'hum', 'pres', 'bat', 'bat_v', 'inc')}
        t['heading'] = d.get('rumbo')
        t['alert'] = d.get('alerta', 0)
        t['mode'] = 'auto' if self.modo == 'AUTOMATICO' else 'manual'
        t['state'] = self.estado
        t['points'] = len(self.crumbs)
        t['x'], t['y'] = round(self.x, 2), round(self.y, 2)
        if self.arm_real:
            t['arm'] = self.arm_real[:4]
        if self.grip_real is not None:
            t['grip'] = self.grip_real
        lid = self.lidar_72()
        if lid:
            t['lidar'] = lid
        return {k: v for k, v in t.items() if v is not None}

    def aplicar_ordenes(self):
        """Vacía la cola de la pasarela y reutiliza los mismos callbacks que los topics de ROS."""
        q = self.cloud.ordenes
        while True:
            try:
                o = q.get_nowait()
            except Exception:  # cola vacía
                break
            t = o['t']
            if t == 'hb':
                if o['vivo']:
                    self.last_hb = time.monotonic()
            elif t == 'estop':
                self.drive_nube = False
                self.estop_cb(Bool(data=True))
            elif t == 'mode':
                self.modo_cb(String(data='automatico' if o['v'] == 'auto' else 'manual'))
            elif t == 'arm' and o.get('v'):
                self.arm_cb(Float32MultiArray(data=[float(x) for x in o['v']]))
            elif t == 'grip' and o.get('v') is not None:
                self.grip_cb(Float32(data=float(o['v'])))
            elif t == 'drive':
                mov = abs(o['lin']) > 1e-3 or abs(o['ang']) > 1e-3
                if mov or self.drive_nube:           # el cero solo se envía al terminar de conducir
                    m = Twist()
                    m.linear.x, m.angular.z = o['lin'], o['ang']
                    self.cmd_vel_cb(m)
                self.drive_nube = mov

    # ---------- LiDAR ----------
    def scan_cb(self, msg: LaserScan):
        off = math.radians(self.front_offset)
        pts = []
        for i, r in enumerate(msg.ranges):
            if not (msg.range_min < r < msg.range_max):   # descarta nan, inf y ceros
                continue
            a = msg.angle_min + i * msg.angle_increment + off
            pts.append((math.degrees(norm_ang(a)), r))
        self.pts = pts
        self.range_max = msg.range_max
        self.scan_t = time.monotonic()

    def sector_min(self, a0: float, a1: float) -> float:
        vals = [r for a, r in self.pts if a0 <= a <= a1]
        return min(vals) if vals else self.range_max

    def evitar(self) -> bool:
        """True si ya envió un comando: sin LiDAR se detiene, con obstáculo gira."""
        if time.monotonic() - self.scan_t > 0.6:
            self.enviar('AUTO:0,0')
            self.get_logger().warn('Sin datos del LiDAR /scan: robot detenido', throttle_duration_sec=2.0)
            return True
        fh, sa = self.front_half, self.side_angle
        frente = self.sector_min(-fh, fh)
        if frente < self.obstacle_dist or (self.giro and frente < self.obstacle_dist * 1.3):
            if self.giro is None:
                izq = self.sector_min(fh, sa)       # +ángulo = izquierda
                der = self.sector_min(-sa, -fh)
                self.giro = 'izq' if izq >= der else 'der'
                self.get_logger().warn(f'Obstáculo a {frente:.2f} m, girando a la {self.giro}')
            t = self.turn_speed
            self.enviar(f'AUTO:{-t},{t}' if self.giro == 'izq' else f'AUTO:{t},{-t}')
            return True
        self.giro = None
        return False

    # ---------- Diagrama de flujo (10 Hz) ----------
    def tick(self):
        perdida = time.monotonic() - self.last_hb
        if self.estado == 'NORMAL':
            if perdida > self.rth_after:
                self.iniciar_rth()
            elif self.modo == 'AUTOMATICO' and not self.evitar():
                self.enviar(f'AUTO:{self.auto_speed},{self.auto_speed}')
        elif self.estado == 'RTH':
            self.tick_rth()

        self.n_tick += 1
        if self.n_tick % 5 == 0:
            self.pub_status.publish(String(data=json.dumps({
                'estado': self.estado, 'perdida': round(perdida, 1), 'puntos': len(self.crumbs),
                'x': round(self.x, 2), 'y': round(self.y, 2),
                'theta_deg': round(math.degrees(self.theta), 1)})))

    def iniciar_rth(self):
        if self.alerta_prev:
            self.estado = 'ESPERA'
            self.enviar('STOP')
            self.get_logger().error('Sin señal y con alerta de gas/temperatura: el robot queda detenido')
            return
        self.estado = 'RTH'
        self.giro = None
        self.t_modo_cmd = 0.0
        self.get_logger().warn(f'Sin señal de la estación base por más de {self.rth_after:.0f} s: '
                               f'activando retorno a base ({len(self.crumbs) - 1} puntos)')

    def tick_rth(self):
        ahora = time.monotonic()
        if self.modo != 'AUTOMATICO':
            if ahora - self.t_modo_cmd > 1.0:
                self.t_modo_cmd = ahora
                self.enviar('MODE:AUTO')
            return
        while len(self.crumbs) > 1 and math.hypot(self.x - self.crumbs[-1][0],
                                                  self.y - self.crumbs[-1][1]) < self.reach:
            self.crumbs.pop()
        bx, by = self.crumbs[0]
        if len(self.crumbs) == 1 and math.hypot(self.x - bx, self.y - by) < self.reach:
            self.enviar('STOP')
            self.estado = 'ESPERA'
            self.giro = None
            self.get_logger().info('El robot llegó a la base: detenido y en espera')
            return
        if self.evitar():
            return
        tx, ty = self.crumbs[-1]
        err = norm_ang(math.atan2(ty - self.y, tx - self.x) - self.theta)
        if abs(err) > math.radians(self.heading_tol):          # primero se alinea
            t = self.turn_speed
            self.enviar(f'AUTO:{-t},{t}' if err > 0 else f'AUTO:{t},{-t}')
        else:                                                   # avanza corrigiendo el rumbo
            s = int(self.steer_gain * err)
            v = self.rth_speed
            self.enviar(f'AUTO:{v - s},{v + s}')


def main(args=None):
    rclpy.init(args=args)
    nodo = JetsonRobotBridge()
    try:
        rclpy.spin(nodo)
    except KeyboardInterrupt:
        pass
    finally:
        nodo.enviar('STOP')
        nodo.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
