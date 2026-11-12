#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <Adafruit_ADS1X15.h>
#include <Adafruit_BNO055.h>
#include <ESP32Servo.h>

/*
  ESP32 - control del robot minero (según el esquema "Conexión control y comunicación")

  La Jetson está cableada a TXD0/RXD0 del ESP32 (UART0, la misma del USB). Por eso:
    - Todo viaja por Serial a 115200.
    - Los comandos de la Jetson empiezan con '#' y terminan en \n (ej. "#DRV:120,120").
    - Las teclas sueltas W A S D X M U siguen funcionando desde el monitor serie.
    - Para programar el ESP32 por USB, desconecta los cables TX/RX de la Jetson.

  Comandos de la Jetson:
    #MODE:AUTO | #MODE:MANUAL   cambia de modo
    #STOP                       para y pasa a manual
    #DRV:izq,der                conducción manual (PWM -255..255), caduca en 500 ms
    #AUTO:izq,der               conducción automática (PWM -255..255), caduca en 800 ms
    #ARM:base,hombro,codo,muneca  ángulos -90..90 (0 = centro del servo). Con 3 valores no mueve la muñeca
    #GRIP:pct                   pinza 0 (cerrada) .. 100 (abierta)

  Telemetría: una línea JSON cada 100 ms.
*/

// --- MOTORES (BTS7960) ---
const int R_PWM_M1 = 23, L_PWM_M1 = 25, R_EN_M1 = 32, L_EN_M1 = 33;  // izquierdo
const int R_PWM_M2 = 14, L_PWM_M2 = 4,  R_EN_M2 = 5,  L_EN_M2 = 15;  // derecho

// --- ENCODERS (JGA25-370): M1 A=34 B=35, M2 A=2 B=12 ---
const int ENC1_A = 34, ENC1_B = 35, ENC2_A = 2, ENC2_B = 12;
const int ENC_SIGNO_IZQ = 1;   // pon -1 si al avanzar la cuenta de esa rueda baja
const int ENC_SIGNO_DER = 1;

// --- SERVOS: SERVO1=GPIO27 base, SERVO2=GPIO18 hombro, SERVO3=GPIO19 codo, SERVO5=GPIO26 muñeca, SERVO4=GPIO13 pinza ---
// GPIO26 está libre en el esquema y admite PWM. Alimenta el servo de la muñeca desde la fuente de 5-6 V
// de los servos (NO desde el pin 5V del ESP32) y une las tierras (GND común).
const int N_SERVO = 5;
const int PIN_SERVO[N_SERVO] = {27, 18, 19, 26, 13};   // base, hombro, codo, muñeca, pinza
const int N_ARTIC = 4;                                 // articulaciones que mueve #ARM (base..muñeca)
const int IDX_MUNECA = 3;
const int IDX_PINZA = 4;
const int GRIP_ANG_CERRADA = 10;   // ángulo del servo con la pinza cerrada
const int GRIP_ANG_ABIERTA = 90;   // ángulo del servo con la pinza abierta
const float PASO_SERVO = 2.0;      // grados por cada 20 ms

// --- PARÁMETROS ---
const int VELOCIDAD_MANUAL = 190;
const unsigned long DRV_TIMEOUT_MS  = 500;
const unsigned long AUTO_TIMEOUT_MS = 800;
const unsigned long TELEMETRIA_MS   = 100;
const int16_t CO_RAW_ALERTA = 22000;                 // cuentas del ADS1115
const float   TEMP_ALERTA   = 65.0;                  // °C
const float   CO_PPM_POR_CUENTA = 50.0 / 22000.0;    // CALIBRAR con tu sensor

// --- SENSORES ANALÓGICOS EN EL ADS1115: A0 = CO, A1 = batería, A2 = metano, A3 = oxígeno ---
// Pon en 0 los que no tengas conectados (una entrada al aire daría lecturas falsas y alertas falsas)
#define HAY_BATERIA 1
#define HAY_CH4     1
#define HAY_O2      1
#define HAY_H2S     1   // sulfuro de hidrógeno: segundo ADS1115 (dirección 0x49, pin ADDR a VDD), canal A0
const float ADS_LSB_V   = 0.0001875;            // volts por cuenta con la ganancia por defecto (±6.144 V)
const float BAT_DIVISOR = 11.0;                 // divisor resistivo hacia A1: (R1+R2)/R2, p. ej. 100k + 10k
const int   BAT_CELDAS  = 7;                    // celdas 18650 en serie (7S = 25.9 V nominales)
const float CH4_PCT_POR_CUENTA = 2.0 / 20000.0; // CALIBRAR: % de metano por cuenta
const float O2_PCT_POR_CUENTA  = 20.9 / 16000.0;// CALIBRAR: % de oxígeno por cuenta
const float CH4_ALERTA = 1.5;                   // % de metano que detiene el robot
const float O2_ALERTA  = 19.5;                  // % de oxígeno por debajo del cual se detiene
const float H2S_PPM_POR_CUENTA = 20.0 / 20000.0;// CALIBRAR: ppm de H2S por cuenta
const float H2S_ALERTA = 10.0;                  // ppm de H2S que detiene el robot (techo NIOSH: 10 ppm)

enum ModoOperacion { MODO_MANUAL, MODO_AUTOMATICO };
ModoOperacion modoActual = MODO_MANUAL;   // siempre arranca en manual

// --- Prototipos ---
void moverMotores(int velIzq, int velDer);
void detenerRobot();
void cambiarModo(ModoOperacion nuevo, const char* origen);
void procesarEntradaTeclado(char tecla);
void procesarComandoJetson(String cmd);
void leerSerial();
void leerSensores();
void verificarSeguridad();
void vigilarComandos(unsigned long ahora);
void actualizarServos(unsigned long ahora);
void enviarTelemetria();
int  parseLista(const String& s, float* out, int maxN);
float porcentajeBateria(float vCelda);

// --- Encoders ---
volatile long ticksIzq = 0, ticksDer = 0;
void IRAM_ATTR isrEncIzq() { ticksIzq = ticksIzq + (digitalRead(ENC1_B) ? -ENC_SIGNO_IZQ : ENC_SIGNO_IZQ); }
void IRAM_ATTR isrEncDer() { ticksDer = ticksDer + (digitalRead(ENC2_B) ? -ENC_SIGNO_DER : ENC_SIGNO_DER); }

// --- Sensores ---
Adafruit_BME280 bme;
Adafruit_ADS1115 ads;    // 0x48: A0 CO, A1 batería, A2 metano, A3 oxígeno
Adafruit_ADS1115 ads2;   // 0x49: A0 sulfuro de hidrógeno (H2S)
Adafruit_BNO055 bno = Adafruit_BNO055(55, 0x28);
bool bmeOk = false, adsOk = false, ads2Ok = false, bnoOk = false;
float temp = NAN, hum = NAN, pres = NAN;
int16_t coRaw = 0;
float batV = NAN, batPct = NAN, ch4 = NAN, o2 = NAN, h2s = NAN;
bool alertaActiva = false;

// --- Estado ---
Servo servos[N_SERVO];
float posActual[N_SERVO]   = {90, 90, 90, 90, 90};
float posObjetivo[N_SERVO] = {90, 90, 90, 90, 90};
bool drvActivo = false, autoMoviendo = false, enviarYa = false;
unsigned long ultimoDRV = 0, ultimoAUTO = 0, ultimaTelemetria = 0, ultimaLectura = 0, ultimoServo = 0;
String bufferCmd;

void setup() {
  Serial.begin(115200);

  pinMode(R_PWM_M1, OUTPUT); pinMode(L_PWM_M1, OUTPUT);
  pinMode(R_EN_M1, OUTPUT);  pinMode(L_EN_M1, OUTPUT);
  pinMode(R_PWM_M2, OUTPUT); pinMode(L_PWM_M2, OUTPUT);
  pinMode(R_EN_M2, OUTPUT);  pinMode(L_EN_M2, OUTPUT);
  digitalWrite(R_EN_M1, HIGH); digitalWrite(L_EN_M1, HIGH);
  digitalWrite(R_EN_M2, HIGH); digitalWrite(L_EN_M2, HIGH);
  detenerRobot();

  pinMode(ENC1_A, INPUT); pinMode(ENC1_B, INPUT);
  pinMode(ENC2_A, INPUT); pinMode(ENC2_B, INPUT);
  attachInterrupt(digitalPinToInterrupt(ENC1_A), isrEncIzq, RISING);
  attachInterrupt(digitalPinToInterrupt(ENC2_A), isrEncDer, RISING);

  for (int i = 0; i < N_SERVO; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(PIN_SERVO[i], 500, 2400);
    servos[i].write(90);
  }

  Wire.begin(21, 22);
  bmeOk = bme.begin(0x76);
  adsOk = ads.begin();
  if (adsOk) ads.setDataRate(RATE_ADS1115_860SPS);   // 4 lecturas seguidas sin demorar el lazo
#if HAY_H2S
  ads2Ok = ads2.begin(0x49);
  if (ads2Ok) ads2.setDataRate(RATE_ADS1115_860SPS);
  else Serial.println("[WARN] Segundo ADS1115 (0x49, H2S) no detectado");
#endif
  bnoOk = bno.begin(OPERATION_MODE_IMUPLUS);   // sin magnetómetro: el rumbo no se altera por el metal de la mina
  if (!bmeOk) Serial.println("[WARN] Sensor BME280 no detectado");
  if (!adsOk) Serial.println("[WARN] ADS1115 no detectado");
  if (!bnoOk) Serial.println("[WARN] Sensor IMU BNO055 no detectado");
  Serial.println("Robot minero listo. Teclas: W A S D X, M manual, U automatico");
}

void loop() {
  unsigned long ahora = millis();

  leerSerial();

  if (ahora - ultimaLectura >= 200) {
    leerSensores();
    verificarSeguridad();
    ultimaLectura = ahora;
  }

  vigilarComandos(ahora);
  actualizarServos(ahora);

  if (enviarYa || ahora - ultimaTelemetria >= TELEMETRIA_MS) {
    enviarTelemetria();
    ultimaTelemetria = ahora;
    enviarYa = false;
  }
}

// ================= MOTORES =================
void moverMotores(int velIzq, int velDer) {
  if (alertaActiva) { velIzq = 0; velDer = 0; }   // con alerta crítica no se mueve
  velIzq = constrain(velIzq, -255, 255);
  velDer = constrain(velDer, -255, 255);

  analogWrite(R_PWM_M1, velIzq > 0 ? velIzq : 0);
  analogWrite(L_PWM_M1, velIzq < 0 ? -velIzq : 0);
  analogWrite(R_PWM_M2, velDer > 0 ? velDer : 0);
  analogWrite(L_PWM_M2, velDer < 0 ? -velDer : 0);
}

void detenerRobot() {
  moverMotores(0, 0);
  drvActivo = false;
  autoMoviendo = false;
}

void cambiarModo(ModoOperacion nuevo, const char* origen) {
  enviarYa = true;
  if (nuevo == modoActual) return;
  if (nuevo == MODO_AUTOMATICO && alertaActiva) {
    Serial.println("[ALERTA] No se puede pasar a automatico con una alerta de gas/temperatura");
    return;
  }
  detenerRobot();
  modoActual = nuevo;
  Serial.print(">>> MODO: ");
  Serial.print(nuevo == MODO_MANUAL ? "MANUAL" : "AUTOMATICO");
  Serial.print(" (");
  Serial.print(origen);
  Serial.println(") <<<");
}

// ================= ENTRADA SERIE (teclado y Jetson comparten UART0) =================
void leerSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (bufferCmd.length() == 0 && c != '#') {          // sin '#': tecla suelta del teclado
      if (c != '\n') procesarEntradaTeclado(toupper(c));
      continue;
    }
    if (c == '\n') { procesarComandoJetson(bufferCmd.substring(1)); bufferCmd = ""; }
    else if (bufferCmd.length() < 80) bufferCmd += c;
    else bufferCmd = "";
  }
}

void procesarEntradaTeclado(char tecla) {
  if (tecla == 'M') { cambiarModo(MODO_MANUAL, "teclado"); return; }
  if (tecla == 'U') { cambiarModo(MODO_AUTOMATICO, "teclado"); return; }

  if (modoActual != MODO_MANUAL) return;
  drvActivo = false;   // las órdenes de teclado se mantienen hasta 'X'
  switch (tecla) {
    case 'W': moverMotores(VELOCIDAD_MANUAL, VELOCIDAD_MANUAL);   Serial.println("Manual: Avanzando"); break;
    case 'S': moverMotores(-VELOCIDAD_MANUAL, -VELOCIDAD_MANUAL); Serial.println("Manual: Retrocediendo"); break;
    case 'A': moverMotores(-VELOCIDAD_MANUAL, VELOCIDAD_MANUAL);  Serial.println("Manual: Giro Izquierda"); break;
    case 'D': moverMotores(VELOCIDAD_MANUAL, -VELOCIDAD_MANUAL);  Serial.println("Manual: Giro Derecha"); break;
    case 'X':
    default:  detenerRobot(); Serial.println("Manual: Detenido"); break;
  }
}

int parseLista(const String& s, float* out, int maxN) {
  int n = 0, ini = 0;
  while (n < maxN) {
    int c = s.indexOf(',', ini);
    out[n++] = (c < 0 ? s.substring(ini) : s.substring(ini, c)).toFloat();
    if (c < 0) break;
    ini = c + 1;
  }
  return n;
}

void procesarComandoJetson(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;
  float v[N_ARTIC];   // cabe el comando más largo (#ARM con 4 ángulos)

  if (cmd == "MODE:AUTO")        cambiarModo(MODO_AUTOMATICO, "Jetson");
  else if (cmd == "MODE:MANUAL") cambiarModo(MODO_MANUAL, "Jetson");
  else if (cmd == "STOP") {
    detenerRobot();
    cambiarModo(MODO_MANUAL, "PARADA");
  }
  else if (cmd.startsWith("DRV:") && modoActual == MODO_MANUAL) {
    if (parseLista(cmd.substring(4), v, 2) == 2) {
      moverMotores((int)v[0], (int)v[1]);
      drvActivo = (v[0] != 0 || v[1] != 0);
      ultimoDRV = millis();
    }
  }
  else if (cmd.startsWith("AUTO:") && modoActual == MODO_AUTOMATICO) {
    if (parseLista(cmd.substring(5), v, 2) == 2) {
      moverMotores((int)v[0], (int)v[1]);
      autoMoviendo = (v[0] != 0 || v[1] != 0);
      ultimoAUTO = millis();
    }
  }
  else if (cmd.startsWith("ARM:") && modoActual == MODO_MANUAL) {
    int n = parseLista(cmd.substring(4), v, N_ARTIC);       // 3 (sin muñeca) o 4 valores
    if (n >= 3)
      for (int i = 0; i < n; i++) posObjetivo[i] = constrain(v[i], -90, 90) + 90;
  }
  else if (cmd.startsWith("GRIP:") && modoActual == MODO_MANUAL) {
    float p = constrain(cmd.substring(5).toFloat(), 0, 100);
    posObjetivo[IDX_PINZA] = GRIP_ANG_CERRADA + (GRIP_ANG_ABIERTA - GRIP_ANG_CERRADA) * p / 100.0;
  }
}

// Si dejan de llegar órdenes, el robot se detiene solo
void vigilarComandos(unsigned long ahora) {
  if (modoActual == MODO_MANUAL && drvActivo && ahora - ultimoDRV > DRV_TIMEOUT_MS) detenerRobot();
  if (modoActual == MODO_AUTOMATICO && autoMoviendo && ahora - ultimoAUTO > AUTO_TIMEOUT_MS) detenerRobot();
}

// ================= SERVOS =================
void actualizarServos(unsigned long ahora) {
  if (ahora - ultimoServo < 20) return;
  ultimoServo = ahora;
  for (int i = 0; i < N_SERVO; i++) {
    float d = posObjetivo[i] - posActual[i];
    if (fabs(d) > 0.01) {
      posActual[i] += constrain(d, -PASO_SERVO, PASO_SERVO);
      servos[i].write((int)round(posActual[i]));
    }
  }
}

// ================= SENSORES Y SEGURIDAD =================
void leerSensores() {
  if (bmeOk) { temp = bme.readTemperature(); hum = bme.readHumidity(); pres = bme.readPressure() / 100.0f; }
  if (adsOk) {
    coRaw = ads.readADC_SingleEnded(0);
#if HAY_BATERIA
    batV = ads.readADC_SingleEnded(1) * ADS_LSB_V * BAT_DIVISOR;
    batPct = porcentajeBateria(batV / BAT_CELDAS);
#endif
#if HAY_CH4
    ch4 = fmaxf(0.0f, ads.readADC_SingleEnded(2) * CH4_PCT_POR_CUENTA);
#endif
#if HAY_O2
    o2 = ads.readADC_SingleEnded(3) * O2_PCT_POR_CUENTA;
#endif
  }
#if HAY_H2S
  if (ads2Ok) h2s = fmaxf(0.0f, ads2.readADC_SingleEnded(0) * H2S_PPM_POR_CUENTA);
#endif
}

// Curva de descarga aproximada de una celda 18650 sin carga: voltaje por celda -> porcentaje
float porcentajeBateria(float vCelda) {
  static const float V[]   = {3.00, 3.30, 3.50, 3.60, 3.70, 3.80, 3.90, 4.00, 4.10, 4.20};
  static const float PCT[] = {   0,    3,   10,   20,   35,   50,   65,   80,   90,  100};
  const int N = 10;
  if (vCelda <= V[0]) return 0;
  if (vCelda >= V[N - 1]) return 100;
  for (int i = 1; i < N; i++)
    if (vCelda <= V[i]) return PCT[i - 1] + (PCT[i] - PCT[i - 1]) * (vCelda - V[i - 1]) / (V[i] - V[i - 1]);
  return 100;
}

void verificarSeguridad() {
  bool critico = (coRaw > CO_RAW_ALERTA) || (!isnan(temp) && temp > TEMP_ALERTA)
              || (!isnan(ch4) && ch4 >= CH4_ALERTA) || (!isnan(o2) && o2 <= O2_ALERTA)
              || (!isnan(h2s) && h2s >= H2S_ALERTA);
  bool normal  = (coRaw < CO_RAW_ALERTA - 2000) && (isnan(temp) || temp < TEMP_ALERTA - 5)
              && (isnan(ch4) || ch4 < CH4_ALERTA - 0.3) && (isnan(o2) || o2 > O2_ALERTA + 0.3)
              && (isnan(h2s) || h2s < H2S_ALERTA - 2.0);

  if (!alertaActiva && critico) {
    alertaActiva = true;
    detenerRobot();
    modoActual = MODO_MANUAL;   // se revoca la autonomía
    enviarYa = true;
    Serial.println("[ALERTA CRITICA] Parada por concentracion de gases o alta temperatura!");
  } else if (alertaActiva && normal) {
    alertaActiva = false;
    enviarYa = true;
    Serial.println("[INFO] Alerta despejada");
  }
}

String num(float v, int dec = 2) { return isnan(v) ? String("null") : String(v, dec); }

void enviarTelemetria() {
  float roll = NAN, pitch = NAN, rumbo = NAN;
  if (bnoOk) {
    sensors_event_t ev;
    bno.getEvent(&ev);
    rumbo = ev.orientation.x; roll = ev.orientation.y; pitch = ev.orientation.z;
  }
  noInterrupts(); long tIzq = ticksIzq, tDer = ticksDer; interrupts();
  float gripPct = (posActual[IDX_PINZA] - GRIP_ANG_CERRADA) * 100.0 / (GRIP_ANG_ABIERTA - GRIP_ANG_CERRADA);

  String t = "{\"MODO\":\"";
  t += (modoActual == MODO_MANUAL ? "MANUAL" : "AUTOMATICO");
  t += "\",\"ALERTA\":"; t += (alertaActiva ? 1 : 0);
  t += ",\"TEMP\":" + num(temp) + ",\"HUM\":" + num(hum) + ",\"PRES\":" + num(pres, 1);
  t += ",\"CO_RAW\":" + String(coRaw) + ",\"CO\":" + num(coRaw * CO_PPM_POR_CUENTA, 1);
  t += ",\"ROLL\":" + num(roll, 1) + ",\"PITCH\":" + num(pitch, 1) + ",\"RUMBO\":" + num(rumbo, 1);
  t += ",\"BAT_V\":" + num(batV, 2) + ",\"BAT\":" + num(batPct, 0) + ",\"CH4\":" + num(ch4, 2) + ",\"O2\":" + num(o2, 1) + ",\"H2S\":" + num(h2s, 1);
  t += ",\"ENC\":[" + String(tIzq) + "," + String(tDer) + "]";
  t += ",\"ARM\":[";
  for (int i = 0; i < N_ARTIC; i++) { t += String(posActual[i] - 90, 0); if (i < N_ARTIC - 1) t += ","; }
  t += "],\"GRIP\":" + String(constrain(gripPct, 0, 100), 0) + "}";

  Serial.println(t);
}
