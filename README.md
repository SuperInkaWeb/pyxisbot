# Pyxis-Bot · Robot minero de inspección

Repositorio organizado por aplicación:

```
plataforma/            Centro de control web (se publica en Vercel; Root Directory = plataforma)
├── frontend/          Lo que ve el navegador: páginas HTML, estilos y scripts (assets/)
├── backend/           Lógica del servidor: base de datos Neon, sesión Auth0, permisos, robots, correo Resend
├── api/               Endpoints HTTP (Vercel exige este nombre de carpeta); usan backend/
├── pruebas/           Pruebas automáticas y simulador del robot
└── scripts/           Utilidades (cambio de dominio)
robot/
├── esp32/             Firmware del ESP32 (PlatformIO): motores, brazo, pinza y sensores
└── jetson/            Nodos ROS 2 de la Jetson: puente al ESP32, cámara térmica y pasarela a la nube
```

```
Navegador ── HTTPS ── plataforma (Vercel + Auth0 + Neon) ── Internet/Ubiquiti ── Jetson Orin Nano ── UART ── ESP32
                                                                                  ├── cámara RGB (USB)
                                                                                  ├── FLIR Lepton (SPI + I2C)
                                                                                  └── LiDAR Oradar MS200
```

- Centro de control: https://robotmineropyxis-bot-dashboard.vercel.app · configuración y pruebas en [`plataforma/README.md`](plataforma/README.md).
- Versiones: [`CHANGELOG.md`](CHANGELOG.md).


## Robot · ESP32 (VS Code + PlatformIO)
1. Abre `robot/esp32/` en VS Code con PlatformIO, luego Build y Upload (las librerías están en `platformio.ini`).
2. Calibra `CO_PPM_POR_CUENTA`. Prueba los encoders empujando el robot hacia adelante: si la cuenta baja, cambia `ENC_SIGNO_IZQ` o `ENC_SIGNO_DER` a -1.
3. Teclas desde el monitor serie: W A S D, X para detener, M manual, U automático.

## Robot · Jetson
```bash
sudo apt install ros-humble-rosbridge-suite ros-humble-web-video-server ros-humble-v4l2-camera python3-serial python3-opencv
pip3 install pylepton numpy
sudo usermod -aG dialout $USER                  # cierra sesión y vuelve a entrar
sudo /opt/nvidia/jetson-io/jetson-io.py         # activa SPI para la Lepton (/dev/spidev0.0)
```
Terminal 1: el launch del driver del LiDAR MS200 (debe publicar `/scan`).
Terminal 2:
```bash
source /opt/ros/humble/setup.bash
export CLOUD_URL=https://robotmineropyxis-bot-dashboard.vercel.app CLOUD_KEY=pyx_...   # clave del robot (panel → Administración → Robots)
ros2 launch ~/pyxisbot/robot/jetson/robot_minero.launch.py
```
En el launch, `/dev/video0` es la cámara RGB. En `flir_lepton_node.py`, el parámetro `modelo` es 3 para Lepton 3.x y 2 para Lepton 2.x.

**Calibrar la odometría (necesario para el retorno):** empuja el robot 1 m en línea recta y mira `ros2 topic echo /robot_status`. Ajusta el parámetro `ticks_por_metro` del nodo hasta que `x` marque 1.0.

## Modos de operación
| URL | Modo | Requiere |
|---|---|---|
| `/dashboard` | Nube (empresas) | sesión Auth0 |
| `/dashboard?host=IP_JETSON` | Local en la mina (rosbridge, con video) | misma red |
| `/dashboard?demo=1` | Demostración simulada | nada |

- **Señal de la estación base:** el panel manda un latido dos veces por segundo. Si no llega, la Jetson cuenta el tiempo de pérdida.
- **Menos de 5 s sin señal:** espera la reconexión. En manual, el ESP32 se detiene solo a los 500 ms por falta de órdenes.
- **Más de 5 s sin señal:** retorno a base por el camino recorrido (encoders + IMU), esquivando obstáculos con el LiDAR. Al llegar queda en espera.
- **Parada de emergencia:** cancela el retorno y devuelve el control manual.
- **Automático:** evasión de obstáculos y monitoreo continuo. El mapeo SLAM no está incluido.

## Protocolo Jetson → ESP32 (UART0, líneas que empiezan con `#`)
| Comando | Efecto |
|---|---|
| `#MODE:AUTO` / `#MODE:MANUAL` | cambia de modo (AUTO se rechaza con alerta activa) |
| `#STOP` | para y pasa a manual |
| `#DRV:izq,der` | conducción manual, PWM -255..255, caduca a 500 ms |
| `#AUTO:izq,der` | conducción automática, caduca a 800 ms |
| `#ARM:base,hombro,codo,muneca` | ángulos -90..90 (la muñeca va en el servo de GPIO26; con 3 valores no se mueve) |
| `#GRIP:pct` | 0 cerrada .. 100 abierta |

El ESP32 responde con una línea JSON cada 100 ms (modo, alerta, temperatura, humedad, presión, CO, metano, oxígeno, batería, roll, pitch, rumbo, encoders, brazo y pinza).

## Límites
- ROS 2, el ESP32 y la pasarela **no se probaron con hardware** (solo sintaxis y simulador).
- El video no viaja por la nube; solo en modo local.
- No está certificado para atmósferas explosivas (ATEX/IECEx).
