"""
Pasarela a la nube del robot minero (solo biblioteca estándar).

Hace dos cosas, en un hilo aparte para no bloquear ROS:
  · Envía la telemetría cada `push_s` segundos:   POST {url}/api/telemetry   (cabecera X-Api-Key)
  · Pregunta las órdenes cada `poll_s` segundos:  GET  {url}/api/command     (cabecera X-Api-Key)

El hilo NUNCA toca ROS ni el puerto serie: deja las órdenes en una cola y el nodo las aplica
desde su hilo principal (ver `aplicar_ordenes` en jetson_robot_bridge.py).
Si no hay Internet, la pasarela sigue intentando; sin latido del operador el puente ya regresa
solo a la base (RTH), que es el comportamiento diseñado.
"""
import json
import queue
import threading
import time
import urllib.error
import urllib.request


class CloudGateway:
    def __init__(self, url, key, push_s=1.0, poll_s=0.25, snapshot=None, log=None):
        self.url = url.rstrip('/')
        self.key = key
        self.push_s = max(0.5, float(push_s))
        self.poll_s = max(0.1, float(poll_s))
        self.snapshot = snapshot or (lambda: {})      # función que devuelve el dict de telemetría
        self.log = log or (lambda m: None)
        self.ordenes = queue.Queue(maxsize=64)
        self.conectado = False
        self._stop = threading.Event()
        self._seq = {}                                # último seq visto: modeSeq, estopSeq, armSeq, gripSeq
        self._primera = True
        self._hilos = [threading.Thread(target=self._bucle_push, daemon=True),
                       threading.Thread(target=self._bucle_poll, daemon=True)]

    def iniciar(self):
        for h in self._hilos:
            h.start()

    def parar(self):
        self._stop.set()

    # ---------- HTTP ----------
    def _http(self, metodo, ruta, cuerpo=None):
        datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
        req = urllib.request.Request(self.url + ruta, data=datos, method=metodo,
                                     headers={'X-Api-Key': self.key, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=4) as r:
            return json.loads(r.read().decode() or '{}')

    def _fallo(self, e, que):
        if self.conectado:
            self.log(f'Nube: se perdió la conexión ({que}: {e})')
        self.conectado = False

    # ---------- telemetría ----------
    def _bucle_push(self):
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._http('POST', '/api/telemetry', self.snapshot())
                if not self.conectado:
                    self.log('Nube: conectada')
                self.conectado = True
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    self.log('Nube: clave del robot rechazada (revisa cloud_key: la clave pyx_... del robot en el panel)')
                self._fallo(e, 'telemetría')
            except Exception as e:  # noqa: BLE001  (red caída, DNS, timeout…)
                self._fallo(e, 'telemetría')
            self._stop.wait(max(0.0, self.push_s - (time.monotonic() - t0)))

    # ---------- órdenes ----------
    def _bucle_poll(self):
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self._procesar(self._http('GET', '/api/command'))
            except Exception as e:  # noqa: BLE001
                self._fallo(e, 'órdenes')
            self._stop.wait(max(0.0, self.poll_s - (time.monotonic() - t0)))

    def _poner(self, orden):
        try:
            self.ordenes.put_nowait(orden)
        except queue.Full:
            pass

    def _cambio(self, clave, valor):
        previo = self._seq.get(clave)
        self._seq[clave] = valor
        return previo is not None and valor != previo

    def _procesar(self, r):
        # Latido del operador: hay alguien con el panel abierto hace menos de 3 s
        hb = r.get('hbAge')
        self._poner({'t': 'hb', 'vivo': hb is not None and hb < 3.0})
        estop_cambio = self._cambio('estopSeq', r.get('estopSeq'))
        mode_cambio = self._cambio('modeSeq', r.get('modeSeq'))
        arm_cambio = self._cambio('armSeq', (r.get('arm') or {}).get('seq'))
        grip_cambio = self._cambio('gripSeq', (r.get('grip') or {}).get('seq'))
        if self._primera:
            # Al arrancar solo se adopta una parada de emergencia vigente; nunca se reanuda un modo,
            # brazo o pinza antiguos.
            self._primera = False
            if r.get('estop'):
                self._poner({'t': 'estop'})
            return
        if r.get('estop'):
            if estop_cambio:
                self._poner({'t': 'estop'})
            self._poner({'t': 'drive', 'lin': 0.0, 'ang': 0.0})
            return
        if mode_cambio:
            self._poner({'t': 'mode', 'v': r.get('mode')})
        if arm_cambio:
            self._poner({'t': 'arm', 'v': (r.get('arm') or {}).get('v')})
        if grip_cambio:
            self._poner({'t': 'grip', 'v': (r.get('grip') or {}).get('v')})
        cmd = r.get('cmd')
        self._poner({'t': 'drive', 'lin': float(cmd['lin']), 'ang': float(cmd['ang'])} if cmd
                    else {'t': 'drive', 'lin': 0.0, 'ang': 0.0})
