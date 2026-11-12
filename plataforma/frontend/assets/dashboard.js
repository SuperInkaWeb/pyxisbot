"use strict";

/* ========= CONFIGURACIÓN =========
   Tres modos, según la dirección con la que se abra la página:
     /dashboard            NUBE   datos y órdenes por la API (requiere iniciar sesión). Es el modo normal.
     /dashboard?demo=1     DEMO   datos simulados, sin cuenta y sin robot.
     /dashboard?host=IP    LOCAL  conexión directa por rosbridge a la Jetson en la misma red (con video).
*/
const _q = new URLSearchParams(location.search);
const HOST = _q.get("host") || "";                                   // IP de la Jetson (solo modo local)
const DEMO = _q.has("demo") || (_q.has("host") && !HOST);            // ?host= vacío también es demo (compatibilidad)
const LOCAL = !DEMO && !!HOST;
const NUBE = !DEMO && !LOCAL;
let USER = null, SOLO_LECTURA = false, ROBOT = null;   // ROBOT: id del robot elegido (empresa con varios)
const CONFIG = {
  rosbridge: LOCAL ? `ws://${HOST}:9090` : "",
  camaras: {   // web_video_server (solo modo local)
    visual: LOCAL ? `http://${HOST}:8080/stream?topic=/camera/image_raw&type=mjpeg&quality=60` : "",
    flir:   LOCAL ? `http://${HOST}:8080/stream?topic=/flir/image_raw&type=mjpeg&quality=60` : ""
  },
  topics: {
    cmdVel:  "/cmd_vel",            // geometry_msgs/Twist
    modo:    "/robot_mode",         // std_msgs/String ("manual" | "automatico")
    modoEst: "/robot_mode_state",   // std_msgs/String ("MANUAL" | "AUTOMATICO") modo real del ESP32
    pinza:   "/gripper_cmd",        // std_msgs/Float32 (0 cerrada - 100 abierta)
    pinzaEst:"/gripper_state",      // std_msgs/Float32MultiArray [posición %, 0]
    brazo:   "/arm_cmd",            // std_msgs/Float32MultiArray [base, hombro, codo, muñeca] grados
    brazoEst:"/arm_state",          // idem, posición real
    estop:   "/estop",              // std_msgs/Bool
    scan:    "/scan",               // sensor_msgs/LaserScan (Oradar MS200)
    sensores:"/sensores",           // std_msgs/String con JSON
    heartbeat:"/dashboard_heartbeat", // std_msgs/Bool, latido hacia la Jetson (señal de la estación base)
    estado:  "/robot_status"         // std_msgs/String JSON {estado, perdida, puntos, x, y}
  },
  lidarRangoMax: 12,                // m
  lidarOffsetGrados: 0              // si el LiDAR está girado respecto al frente del robot
};


/* ========= ESTADO ========= */
const $ = id => document.getElementById(id);
const estado = { modo:"manual", lin:0, ang:0, dir:null, pinza:50, datos:{}, scan:null, ros:null, pubs:{}, ultimoSensores:0, scanTs:0, estopNube:false, cambioModo:0, mov:false, armSync:false, pinzaSync:false };

/* ========= ROS (rosbridge en la Jetson) ========= */
function conexion(ok,txt){ $("punto").className="punto"+(ok?" ok":""); $("textoConexion").textContent=txt; }
function pub(nombre,msg){ if(NUBE) return pubNube(nombre,msg); const p=estado.pubs[nombre]; if(p && estado.ros && estado.ros.isConnected) p.publish(new ROSLIB.Message(msg)); }
const simulando = () => DEMO;
function iniciarROS(){
  if(!LOCAL) return;
  if(typeof ROSLIB==="undefined"){      // roslib solo se descarga en modo local
    const sc=document.createElement("script"); sc.src="https://cdn.jsdelivr.net/npm/roslib@1.4.1/build/roslib.min.js";
    sc.onload=iniciarROS; sc.onerror=()=>conexion(false,"No se cargó roslib (el PC necesita internet)");
    document.head.appendChild(sc); return;
  }
  const ros = new ROSLIB.Ros({url:CONFIG.rosbridge}); estado.ros = ros;
  const T = CONFIG.topics;
  const topic=(name,type,opts)=>new ROSLIB.Topic(Object.assign({ros,name,messageType:type},opts||{}));
  ros.on("connection",()=>{ conexion(true,"Conectado a la Jetson ("+HOST+")"); estado.armSync=false; estado.pinzaSync=false; });
  ros.on("close",()=>{ conexion(false,"Sin conexión con la Jetson, reintentando…"); setTimeout(iniciarROS,3000); });
  ros.on("error",()=>{});
  estado.pubs = {
    cmdVel:topic(T.cmdVel,"geometry_msgs/Twist"), modo:topic(T.modo,"std_msgs/String"),
    pinza:topic(T.pinza,"std_msgs/Float32"), brazo:topic(T.brazo,"std_msgs/Float32MultiArray"),
    estop:topic(T.estop,"std_msgs/Bool"), hb:topic(T.heartbeat,"std_msgs/Bool")
  };
  topic(T.scan,"sensor_msgs/LaserScan",{throttle_rate:100,queue_length:1}).subscribe(m=>{ estado.scan=m; estado.scanTs=Date.now(); });
  topic(T.sensores,"std_msgs/String").subscribe(m=>{
    try{
      Object.assign(estado.datos,JSON.parse(m.data)); estado.ultimoSensores=Date.now();
      mostrarAlerta(!!estado.datos.alerta);
    }catch(e){}
  });
  topic(T.modoEst,"std_msgs/String").subscribe(m=>{
    if(Date.now()-estado.cambioModo<1500) return;      // da tiempo al ESP32 a confirmar el cambio pedido
    const nuevo = m.data==="AUTOMATICO" ? "automatico" : "manual";
    if(nuevo!==estado.modo) ponerModo(nuevo,false);
  });
  topic(T.estado,"std_msgs/String").subscribe(m=>{
    try{
      bannerEstado(JSON.parse(m.data));
    }catch(e){}
  });
  topic(T.brazoEst,"std_msgs/Float32MultiArray").subscribe(m=>{
    m.data.forEach((v,i)=>{ if(ARM[i]) $("real_"+ARM[i].k).textContent="real "+v.toFixed(0)+"°"; });
    if(!estado.armSync){ estado.armSync=true; ARM.forEach((a,i)=>{ if(!Number.isFinite(m.data[i])) return; a.v=Math.round(m.data[i]); $("in_"+a.k).value=a.v; $("out_"+a.k).textContent=a.v+"°"; }); dibujarBrazo(); }
  });
  topic(T.pinzaEst,"std_msgs/Float32MultiArray").subscribe(m=>{
    $("pinzaPos").textContent=m.data[0].toFixed(0);
    if(!estado.pinzaSync){ estado.pinzaSync=true; estado.pinza=Math.round(m.data[0]); $("pinza").value=estado.pinza; $("pinzaTxt").textContent=estado.pinza; }
  });
}

/* ========= MODO ========= */
function ponerModo(m, enviar=true){
  estado.modo=m;
  const auto = m==="automatico";
  $("btnManual").setAttribute("aria-pressed",!auto);
  $("btnAuto").setAttribute("aria-pressed",auto);
  $("estadoModo").textContent="Modo actual: "+(auto?"AUTOMÁTICO":"MANUAL");
  $("estadoModo").classList.toggle("auto",auto);
  $("cabecera").classList.toggle("auto",auto);
  $("controles").classList.toggle("es-auto",auto);
  $("fsMando").disabled=auto||SOLO_LECTURA; $("fsPinza").disabled=auto||SOLO_LECTURA; $("fsBrazo").disabled=auto||SOLO_LECTURA;
  if(auto) detener();
  // Centro de mando: en automático solo se muestra "Ambiente y energía"
  $("avisoCentro").hidden=!auto;
  mostrarPanel(auto ? "pAmbiente" : panelManual, false);
  if(enviar){ estado.cambioModo=Date.now(); pub("modo",{data:m}); }
}

/* ========= CENTRO DE MANDO (pestañas) =========
   Manual: Conducción · Brazo y pinza · Ambiente y energía. Automático: solo Ambiente y energía.
   Las cámaras no cambian de lugar; el panel elegido aparece a su lado. */
const PANELES = ["pCarro","pBrazo","pAmbiente"];
var panelManual = (()=>{ try{ const v=localStorage.getItem("pyx_panel"); return PANELES.includes(v)?v:"pCarro"; }catch(e){ return "pCarro"; } })();
var panelActual = null;
function mostrarPanel(id, recordar=true){
  if(id===panelActual) return;
  panelActual = id;
  PANELES.forEach(p=>{
    const on = p===id, t=document.querySelector(`.pestanas [data-panel="${p}"]`);
    $(p).hidden = !on;
    t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
  });
  if(recordar && estado.modo!=="automatico"){ panelManual=id; try{ localStorage.setItem("pyx_panel",id); }catch(e){} }
  if(id==="pAmbiente") requestAnimationFrame(()=>{ try{ dibujarGrafico(); }catch(e){} });   // el gráfico necesita su ancho visible
}
document.querySelectorAll(".pestanas [role=tab]").forEach(t=>t.addEventListener("click",()=>mostrarPanel(t.dataset.panel)));
$("btnManual").onclick=()=>{ if(!SOLO_LECTURA) ponerModo("manual"); };
$("btnAuto").onclick=()=>{ if(!SOLO_LECTURA) ponerModo("automatico"); };

/* ========= MANEJO ========= */
const DIRS = {adelante:[1,0], atras:[-1,0], izquierda:[0,1], derecha:[0,-1], alto:[0,0]};
function fijarDir(d){ estado.dir=d; }
function detener(){ estado.dir=null; estado.lin=0; estado.ang=0; mostrarCmd(); pub("cmdVel",{linear:{x:0,y:0,z:0},angular:{x:0,y:0,z:0}}); }
function mostrarCmd(){ $("cmdLin").textContent=estado.lin.toFixed(2); $("cmdAng").textContent=estado.ang.toFixed(2); }
document.querySelectorAll("#mando button").forEach(b=>{
  const d=b.dataset.d;
  const ini=e=>{e.preventDefault(); fijarDir(d); marcarBoton(d)};
  const fin=()=>{ if(d!=="alto"){ fijarDir(null); marcarBoton(null);} };
  b.addEventListener("pointerdown",ini); b.addEventListener("pointerup",fin);
  b.addEventListener("pointerleave",fin); b.addEventListener("pointercancel",fin);
});
function marcarBoton(d){ document.querySelectorAll("#mando button").forEach(b=>b.classList.toggle("activo",b.dataset.d===d&&d!=="alto")); }
const TECLAS={ArrowUp:"adelante",w:"adelante",ArrowDown:"atras",s:"atras",ArrowLeft:"izquierda",a:"izquierda",ArrowRight:"derecha",d:"derecha"," ":"alto"};
addEventListener("keydown",e=>{ const d=TECLAS[e.key.length===1?e.key.toLowerCase():e.key]; if(!d||estado.modo!=="manual"||SOLO_LECTURA||e.target.matches("input,select,textarea")) return; e.preventDefault(); fijarDir(d); marcarBoton(d); });
addEventListener("keyup",e=>{ const d=TECLAS[e.key.length===1?e.key.toLowerCase():e.key]; if(d&&d!=="alto"){ fijarDir(null); marcarBoton(null);} });
$("vel").oninput=()=>$("velTxt").textContent=(+$("vel").value).toFixed(2);

/* Envío de comando a 10 Hz */
setInterval(()=>{
  if(estado.modo!=="manual" || SOLO_LECTURA) return;
  const v=+$("vel").value, [l,a]=DIRS[estado.dir]||[0,0];
  estado.lin=l*v; estado.ang=a*v*2;
  const gp=[...(navigator.getGamepads?navigator.getGamepads():[])].find(g=>g&&g.connected); let jug=false;
  if(gp){ const y=-gp.axes[1], x=-gp.axes[0]; if(Math.abs(y)>.15||Math.abs(x)>.15){ estado.lin=(Math.abs(y)>.15?y:0)*v; estado.ang=(Math.abs(x)>.15?x:0)*v*2; jug=true; } }
  mostrarCmd();
  if(estado.dir||jug){ pub("cmdVel",{linear:{x:estado.lin,y:0,z:0},angular:{x:0,y:0,z:estado.ang}}); estado.mov=true; }
  else if(estado.mov){ pub("cmdVel",{linear:{x:0,y:0,z:0},angular:{x:0,y:0,z:0}}); estado.mov=false; }
},100);

/* ========= PARADA DE EMERGENCIA ========= */
$("btnParada").onclick=()=>{ detener(); pub("estop",{data:true}); ponerModo("manual",!NUBE); };

/* ========= BRAZO ROBÓTICO ========= */
const ARM = [   // 4 articulaciones: SERVO1 base, SERVO2 hombro, SERVO3 codo, SERVO5 muñeca (GPIO26). SERVO4 es la pinza.
                //   0° = centro del servo, rango ±90°. El orden es el mismo del comando #ARM del ESP32.
  {k:"base",   n:"Base",    min:-90, max:90, v:0, casa:0, plegado:0},
  {k:"hombro", n:"Hombro",  min:-90, max:90, v:0, casa:0, plegado:-85},
  {k:"codo",   n:"Codo",    min:-90, max:90, v:0, casa:0, plegado:85},
  {k:"muneca", n:"Muñeca",  min:-90, max:90, v:0, casa:0, plegado:60}
];
$("articulaciones").innerHTML=ARM.map(a=>`<div class="art"><span>${a.n}</span>
  <input type="range" id="in_${a.k}" min="${a.min}" max="${a.max}" step="1" value="${a.v}" aria-label="${a.n}">
  <div><output id="out_${a.k}">0°</output><small id="real_${a.k}">real --</small></div></div>`).join("");
function enviarBrazo(){ pub("brazo",{data:ARM.map(a=>a.v)}); dibujarBrazo(); }
function ponerBrazo(clave,enviar=true){ ARM.forEach(a=>{ a.v=a[clave]; $("in_"+a.k).value=a.v; $("out_"+a.k).textContent=a.v+"°"; if(simulando()) $("real_"+a.k).textContent="real "+a.v+"°"; }); if(enviar) enviarBrazo(); else dibujarBrazo(); }
ARM.forEach(a=>$("in_"+a.k).oninput=()=>{
  a.v=+$("in_"+a.k).value; $("out_"+a.k).textContent=a.v+"°";
  if(simulando()) $("real_"+a.k).textContent="real "+a.v+"°";
  enviarBrazo();
});
$("btnHome").onclick=()=>ponerBrazo("casa");
$("btnPlegar").onclick=()=>ponerBrazo("plegado");
function dibujarBrazo(){
  const [b,h,c,m]=ARM.map(a=>a.v*Math.PI/180), L=[60,52,30];   // el último tramo (35) es la muñeca con la pinza
  // vista lateral: 0° del hombro = brazo en vertical, positivo hacia delante
  let x=70,y=150, ang=b*0; const pts=[[x,y]];
  let acum=0;
  [h,c,m].forEach((q,i)=>{ acum+=q; x+=Math.sin(acum)*L[i]; y-=Math.cos(acum)*L[i]; pts.push([x,y]); });
  const col=["#5d7a52","#7d9a6e","#a68d5f"];
  let svg='<line x1="10" y1="150" x2="230" y2="150" stroke="#bcb29a" stroke-width="3"/><rect x="50" y="146" width="40" height="14" rx="3" fill="#8a8068"/>';
  for(let i=0;i<3;i++) svg+=`<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[i+1][0]}" y2="${pts[i+1][1]}" stroke="${col[i]}" stroke-width="9" stroke-linecap="round"/>`;
  pts.forEach(p=>svg+=`<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="#ece7da" stroke="#2d3329" stroke-width="2"/>`);
  $("brazoLado").innerHTML=svg;
  // vista superior: giro de la base
  const bx=50+Math.sin(b)*38, by=50-Math.cos(b)*38;
  $("brazoTop").innerHTML=`<circle cx="50" cy="50" r="40" fill="none" stroke="#bcb29a" stroke-width="2"/><line x1="50" y1="50" x2="${bx}" y2="${by}" stroke="#5d7a52" stroke-width="6" stroke-linecap="round"/><circle cx="50" cy="50" r="5" fill="#ece7da" stroke="#2d3329" stroke-width="2"/><text x="50" y="97" text-anchor="middle" font-size="9" fill="#68705c">frente ▲</text>`;
}

/* ========= PINZA ========= */
function enviarPinza(v){ estado.pinza=v; $("pinza").value=v; $("pinzaTxt").textContent=v; pub("pinza",{data:v}); }
$("pinza").oninput=()=>enviarPinza(+$("pinza").value);
$("btnAbrir").onclick=()=>enviarPinza(100);
$("btnCerrar").onclick=()=>enviarPinza(0);

/* ========= WIDGETS: gases, clima y batería ========= */
// Los umbrales deben coincidir con las constantes del firmware (esp32/src/main.cpp): CO_RAW_ALERTA, CH4_ALERTA,
// O2_ALERTA, H2S_ALERTA y TEMP_ALERTA. Los de "Precaución" son solo avisos del dashboard.
const SIMB = ["✓","▲","✖"];
const WID = {
  co:   {grupo:"gases", f:"CO",  corto:"Monóxido", largo:"Monóxido de carbono (CO)", u:"ppm", d:0, min:0,  max:100, aviso:25,  alerta:50,  dir:"alto", parada:true},
  ch4:  {grupo:"gases", f:"CH₄", corto:"Metano",   largo:"Metano (CH₄)",             u:"%",   d:2, min:0,  max:2.5, aviso:1.0, alerta:1.5, dir:"alto", parada:true},
  o2:   {grupo:"gases", f:"O₂",  corto:"Oxígeno",  largo:"Oxígeno (O₂)",             u:"%",   d:1, min:16, max:23,  aviso:20.0,alerta:19.5,dir:"bajo", parada:true},
  h2s:  {grupo:"gases", f:"H₂S", corto:"Sulfuro",  largo:"Sulfuro de hidrógeno (H₂S)",u:"ppm",d:1, min:0,  max:20,  aviso:5,   alerta:10,  dir:"alto", parada:true},
  temp: {grupo:"clima", corto:"Temperatura", largo:"Temperatura", u:"°C", d:1, min:10, max:70, aviso:40, alerta:65, dir:"alto", parada:true, auto:true, conv:true, minSpan:2},
  hum:  {grupo:"clima", corto:"Humedad", largo:"Humedad relativa", u:"%", d:0, min:0, max:100, aviso:85, alerta:95, dir:"alto", auto:true, minSpan:4},
  pres: {grupo:"clima", corto:"Presión", largo:"Presión atmosférica", u:"hPa", d:0, auto:true, minSpan:2, nota:"Sin umbrales de alarma. Un cambio brusco puede indicar un cambio en la ventilación."},
  rocio:{grupo:"clima", corto:"Punto de rocío", largo:"Punto de rocío", u:"°C", d:1, auto:true, conv:true, minSpan:2, nota:"Calculado con temperatura y humedad. Si la temperatura baja hasta este valor, se forma condensación."},
  bat:  {grupo:"energia", corto:"Batería", largo:"Batería", u:"%", d:0, min:0, max:100, aviso:30, alerta:15, dir:"bajo", etiquetas:["Normal","Baja","Crítica"], auto:false}
};
const CLAVES = Object.keys(WID), CONT = {gases:"wGases", clima:"wClima", energia:"wEnergia"};
const HIST = [], MAXH = 3600;                         // una fila por segundo, hasta 1 hora
const sel = {k:"co", tabla:false, ajustada:false, curT:null, pausa:false, nowF:0};
estado.rango = 600; estado.unidadF = false;
const tiles = {};
let UG = null;                                        // último gráfico dibujado (para el cursor)

const fnum = v => (v==null || !isFinite(v)) ? null : +v;
const cv  = (k,v) => (v!=null && WID[k].conv && estado.unidadF) ? v*9/5+32 : v;
const uni = k => (WID[k].conv && estado.unidadF) ? "°F" : WID[k].u;
const fmt = (k,v) => v==null ? "--" : (+cv(k,v)).toFixed(WID[k].d);
const etq = (k,n) => (WID[k].etiquetas || ["Normal","Precaución","Peligro"])[n];
const hora = t => new Date(t).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
const fmtDur = ms => { const s=Math.round(ms/1000); return s<90 ? s+" s" : Math.round(s/60)+" min"; };
const fmtMin = m => m<90 ? Math.round(m)+" min" : Math.floor(m/60)+" h "+Math.round(m%60)+" min";

function rocio(t,h){
  if(t==null || h==null || h<=0) return null;
  const a=17.62, b=243.12, g=Math.log(h/100)+a*t/(b+t);
  return b*g/(a-g);
}
function nivelDe(k,v){
  const w=WID[k]; if(v==null || w.aviso===undefined) return -1;
  if(w.dir==="alto") return v>=w.alerta ? 2 : v>=w.aviso ? 1 : 0;
  return v<=w.alerta ? 2 : v<=w.aviso ? 1 : 0;
}
function mostrarAlerta(al){
  const b=$("banner"); b.hidden=!al;
  if(al) b.textContent="ALERTA: el robot se detuvo por gas (CO, metano, oxígeno o H₂S) o temperatura alta. No se puede pasar a automático hasta que se normalice.";
}

/* ---- historial ---- */
function muestrear(t,forzar){
  const vivo = DEMO || Date.now()-estado.ultimoSensores<3000;
  if(!vivo && !forzar) return;
  const d=estado.datos, f={t:t||Date.now()};
  ["co","ch4","o2","h2s","temp","hum","pres","bat","bat_v"].forEach(k=>f[k]=fnum(d[k]));
  f.rocio=rocio(f.temp,f.hum);
  HIST.push(f); if(HIST.length>MAXH) HIST.shift();
}
function ventana(){
  const t0=Date.now()-estado.rango*1000; let i=0;
  while(i<HIST.length && HIST[i].t<t0) i++;
  return HIST.slice(i);
}
const serie = (k,filas) => filas.filter(f=>f[k]!=null).map(f=>({t:f.t,v:f[k]}));

function autonomia(){                                 // minutos hasta 0 % al ritmo de los últimos 10 min
  const s=serie("bat",HIST.filter(f=>f.t>Date.now()-600000));
  if(s.length<60) return null;                        // todavía calculando
  const t0=s[0].t, n=s.length; let sx=0,sy=0,sxx=0,sxy=0;
  s.forEach(p=>{ const x=(p.t-t0)/1000; sx+=x; sy+=p.v; sxx+=x*x; sxy+=x*p.v; });
  const den=n*sxx-sx*sx; if(den===0) return null;
  const m=(n*sxy-sx*sy)/den;                          // % por segundo
  if(m>-0.0005) return Infinity;                      // estable o cargando
  return s[n-1].v/(-m)/60;
}

/* ---- tarjetas ---- */
function crearTile(k){
  const w=WID[k], b=document.createElement("button");
  b.type="button"; b.className="tile"+(w.aviso===undefined?" sin-umbral":""); b.dataset.k=k; b.dataset.n="x";
  b.setAttribute("aria-pressed","false");
  b.innerHTML=`<span class="t-nom">${w.f?`<b>${w.f}</b> `:""}${w.corto}</span>
    <span class="t-fila"><span class="t-val"><b class="v">--</b><small class="u">${w.u}</small></span><span class="badge"><i></i><span></span></span></span>
    <span class="meter"><i class="fill"></i><u class="tk"></u><u class="tk"></u></span>
    <span class="spark"><svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline class="s-base" points=""/><polyline class="s-ahora" points=""/></svg><span class="pt"></span></span>
    <span class="t-pie">--</span>`;
  b.onclick=()=>seleccionar(k,true);
  return b;
}
function pintarSpark(el,k,s){
  const base=el.querySelector(".s-base"), ahora=el.querySelector(".s-ahora"), pt=el.querySelector(".pt");
  if(s.length<2){ base.setAttribute("points",""); ahora.setAttribute("points",""); pt.style.display="none"; return; }
  const now=Date.now(), ini=Math.max(now-estado.rango*1000,s[0].t), span=Math.max(now-ini,10000);
  const paso=Math.ceil(s.length/40), pts=[];
  for(let i=0;i<s.length;i+=paso){ const g=s.slice(i,i+paso); pts.push({t:g[g.length-1].t, v:g.reduce((a,p)=>a+p.v,0)/g.length}); }
  let lo=Infinity, hi=-Infinity; pts.forEach(p=>{ if(p.v<lo) lo=p.v; if(p.v>hi) hi=p.v; });
  const w=WID[k], minSpan = w.min!==undefined ? (w.max-w.min)*.04 : (w.minSpan||1);
  if(hi-lo<minSpan){ const m=(hi+lo)/2; lo=m-minSpan/2; hi=m+minSpan/2; }
  const X=t=>(t-ini)/span*100, Y=v=>26-(v-lo)/(hi-lo)*22;
  const txt=a=>a.map(p=>X(p.t).toFixed(1)+","+Y(p.v).toFixed(1)).join(" ");
  base.setAttribute("points",txt(pts));
  ahora.setAttribute("points",txt(pts.slice(-Math.max(2,Math.ceil(pts.length*.25)))));
  const u=pts[pts.length-1];
  pt.style.display="block"; pt.style.left=X(u.t).toFixed(1)+"%"; pt.style.top=(Y(u.v)/30*100).toFixed(1)+"%";
}
function pintarWidgets(){
  const vivo = DEMO || Date.now()-estado.ultimoSensores<3000, d=estado.datos, fv=ventana();
  CLAVES.forEach(k=>{
    const w=WID[k], el=tiles[k];
    const v = !vivo ? null : (k==="rocio" ? rocio(fnum(d.temp),fnum(d.hum)) : fnum(d[k]));
    const nv=nivelDe(k,v), s=serie(k,fv);
    el.dataset.n = nv<0 ? "x" : nv;
    el.querySelector(".v").textContent=fmt(k,v);
    el.querySelector(".u").textContent=uni(k);
    if(w.aviso!==undefined){
      const bd=el.querySelector(".badge");
      bd.querySelector("i").textContent = nv<0 ? "–" : SIMB[nv];
      bd.querySelector("span").textContent = nv<0 ? "Sin dato" : etq(k,nv);
      const pos=x=>Math.max(0,Math.min(100,(x-w.min)/(w.max-w.min)*100)), tk=el.querySelectorAll(".tk");
      el.querySelector(".fill").style.width = (v==null ? 0 : pos(v))+"%";
      tk[0].style.left=pos(w.aviso)+"%"; tk[1].style.left=pos(w.alerta)+"%";
    }
    let pie="mín -- · máx --";
    if(s.length){ let lo=Infinity,hi=-Infinity; s.forEach(p=>{ if(p.v<lo) lo=p.v; if(p.v>hi) hi=p.v; }); pie=`mín ${fmt(k,lo)} · máx ${fmt(k,hi)}`; }
    if(k==="bat"){
      const a=autonomia(), vb=fnum(d.bat_v);
      pie=(vivo&&vb!=null ? vb.toFixed(1)+" V · " : "")+(a===null ? "autonomía: calculando…" : a===Infinity ? "autonomía: estable" : a>1440 ? "autonomía > 24 h" : "autonomía ≈ "+fmtMin(a));
    }
    el.querySelector(".t-pie").textContent=pie;
    el.setAttribute("aria-label", `${w.largo}: ${fmt(k,v)} ${uni(k)}`+(w.aviso!==undefined ? ", "+(nv<0 ? "sin dato" : etq(k,nv).toLowerCase()) : ""));
    pintarSpark(el,k,s);
  });
  pintarBateriaHeader(vivo);
  pintarDetalle();
}
function pintarBateriaHeader(vivo){
  const pct=fnum(estado.datos.bat), v=fnum(estado.datos.bat_v), r=$("batRelleno"), t=$("batTxt");
  if(!vivo || pct==null){ r.style.width="0"; t.textContent="-- %"; $("bateria").className="bateria"; return; }
  r.style.width=Math.max(4,Math.min(100,pct))+"%";
  t.textContent=Math.round(pct)+" %"+(v!=null ? "  ("+v.toFixed(1)+" V)" : "");
  $("bateria").className="bateria "+(pct<=15 ? "alerta" : pct<=30 ? "aviso" : "");
}

/* ---- panel de detalle ---- */
function seleccionar(k,mover){
  sel.k=k; sel.curT=null; sel.pausa=false;
  CLAVES.forEach(c=>tiles[c].setAttribute("aria-pressed",c===k));
  pintarDetalle(true);
  if(mover) $("detalle").scrollIntoView({block:"nearest",behavior:matchMedia("(prefers-reduced-motion:reduce)").matches?"auto":"smooth"});
}
function pintarDetalle(forzar){
  const k=sel.k, w=WID[k], vivo=DEMO||Date.now()-estado.ultimoSensores<3000;
  const v = !vivo ? null : (k==="rocio" ? rocio(fnum(estado.datos.temp),fnum(estado.datos.hum)) : fnum(estado.datos[k]));
  const nv=nivelDe(k,v), s=serie(k,ventana());
  $("dTitulo").textContent=w.largo;
  if(w.aviso!==undefined){
    const c=w.dir==="alto" ? "≥" : "≤", n=x=>+(+cv(k,x)).toFixed(w.d);
    $("dUmbrales").textContent=`${etq(k,1)} ${c} ${n(w.aviso)} ${uni(k)} · ${etq(k,2)} ${c} ${n(w.alerta)} ${uni(k)}`+(w.parada ? ". El robot se detiene al llegar a "+etq(k,2).toLowerCase()+"." : "");
  } else $("dUmbrales").textContent=w.nota||"";
  $("btnEscala").hidden = !!w.auto || sel.tabla;     // las magnitudes de clima ya usan escala ajustada
  $("dVal").textContent=fmt(k,v); $("dUni").textContent=uni(k);
  const bd=$("dBadge"); bd.style.visibility = w.aviso===undefined ? "hidden" : "visible";
  bd.dataset.n = nv<0 ? "x" : nv; bd.style.setProperty("--nivel", nv===2?"var(--alerta)":nv===1?"var(--aviso)":nv===0?"var(--ok)":"var(--apagado)");
  bd.querySelector("i").textContent = nv<0 ? "–" : SIMB[nv]; bd.querySelector("span").textContent = nv<0 ? "Sin dato" : etq(k,nv);
  if(s.length){
    let lo=Infinity,hi=-Infinity,sum=0; s.forEach(p=>{ if(p.v<lo) lo=p.v; if(p.v>hi) hi=p.v; sum+=p.v; });
    $("sMin").textContent=fmt(k,lo)+" "+uni(k); $("sMax").textContent=fmt(k,hi)+" "+uni(k); $("sAvg").textContent=fmt(k,sum/s.length)+" "+uni(k);
  } else { ["sMin","sMax","sAvg"].forEach(i=>$(i).textContent="--"); }
  $("sVent").textContent="(últimos "+(estado.rango<3600 ? estado.rango/60+" min" : "60 min")+", "+s.length+" muestras)";
  if(sel.pausa && !forzar) return;                    // mientras lees un valor, el gráfico no se mueve
  if(sel.tabla) dibujarTabla(); else dibujarGrafico();
}

function ticks(lo,hi,n){
  const raw=(hi-lo)/n, mag=Math.pow(10,Math.floor(Math.log10(raw))), nr=raw/mag;
  const step=(nr<1.5?1:nr<3?2:nr<7?5:10)*mag, v=[];
  for(let x=Math.ceil(lo/step)*step; x<=hi+1e-9; x+=step) v.push(+x.toFixed(10));
  return {v, dec: step>=1 ? 0 : Math.min(3,Math.ceil(-Math.log10(step)-1e-9))};
}
function dibujarGrafico(){
  const cont=$("grafico"), svg=$("gsvg"), k=sel.k, w=WID[k], Wd=cont.clientWidth, Ht=cont.clientHeight;
  if(!Wd || !Ht) return;
  const now = sel.pausa ? sel.nowF : Date.now();
  const s=serie(k,ventana()).filter(p=>p.t<=now).map(p=>({t:p.t,v:cv(k,p.v),b:p.v}));
  svg.setAttribute("viewBox",`0 0 ${Wd} ${Ht}`);
  if(s.length<2){ UG=null; $("tip").hidden=true; svg.innerHTML=`<text class="g-txt" x="${Wd/2}" y="${Ht/2}" text-anchor="middle">${DEMO||estado.ultimoSensores?"Recopilando datos…":"Esperando datos del robot…"}</text>`; return; }
  const m={l:50,r:16,t:12,b:26}, iw=Wd-m.l-m.r, ih=Ht-m.t-m.b;
  const tIni=Math.max(now-estado.rango*1000,s[0].t), span=Math.max(now-tIni,10000);
  let lo=Infinity, hi=-Infinity; s.forEach(p=>{ if(p.v<lo) lo=p.v; if(p.v>hi) hi=p.v; });
  if(w.auto || sel.ajustada){
    const base=w.minSpan || (w.max-w.min)*.04, ms=base*(w.conv&&estado.unidadF?1.8:1), sp=Math.max(hi-lo,ms), mid=(hi+lo)/2;
    lo=mid-sp*.6; hi=mid+sp*.6;
    if(!w.conv) lo=Math.max(0,lo);                    // gases, humedad y batería no bajan de cero
    if(k==="hum"||k==="bat") hi=Math.min(100,hi);
  }
  else { lo=Math.min(lo,cv(k,w.min)); hi=Math.max(hi*1.05,cv(k,w.max)); }
  const Y=v=>m.t+ih-(v-lo)/(hi-lo)*ih, X=t=>m.l+(t-tIni)/span*iw;
  let g="";
  if(w.aviso!==undefined){                            // zonas de aviso y peligro
    const ta=cv(k,w.aviso), tp=cv(k,w.alerta), INF=1e9;
    const zonas = w.dir==="alto" ? [[ta,tp,"z1"],[tp,INF,"z2"]] : [[tp,ta,"z1"],[-INF,tp,"z2"]];
    zonas.forEach(([a,b,c])=>{ const za=Math.max(a,lo), zb=Math.min(b,hi); if(za<zb) g+=`<rect class="${c}" x="${m.l}" y="${Y(zb).toFixed(1)}" width="${iw}" height="${(Y(za)-Y(zb)).toFixed(1)}"/>`; });
  }
  const tk=ticks(lo,hi,4);
  tk.v.forEach(v=>{ const y=Y(v).toFixed(1); g+=`<line class="g-rej" x1="${m.l}" x2="${m.l+iw}" y1="${y}" y2="${y}"/><text class="g-txt" x="${m.l-6}" y="${(+y+4).toFixed(1)}" text-anchor="end">${v.toFixed(tk.dec)}</text>`; });
  g+=`<text class="g-txt" x="${m.l}" y="${Ht-7}" text-anchor="start">hace ${fmtDur(now-tIni)}</text>`
   + `<text class="g-txt" x="${m.l+iw/2}" y="${Ht-7}" text-anchor="middle">hace ${fmtDur((now-tIni)/2)}</text>`
   + `<text class="g-txt" x="${m.l+iw}" y="${Ht-7}" text-anchor="end">ahora</text>`;
  if(w.aviso!==undefined) [[w.aviso,1],[w.alerta,2]].forEach(([u,n])=>{
    const val=cv(k,u); if(val<=lo||val>=hi) return;
    const y=Y(val).toFixed(1);
    g+=`<line class="g-um n${n}" x1="${m.l}" x2="${m.l+iw}" y1="${y}" y2="${y}"/><text class="g-um-t" x="${m.l+iw-4}" y="${(+y+(w.dir==="alto"?-4:12)).toFixed(1)}" text-anchor="end">${etq(k,n)} ${(+val).toFixed(w.d)}</text>`;
  });
  const px=Math.max(1,Math.floor(iw/2)), paso=Math.ceil(s.length/px), pts=[];
  for(let i=0;i<s.length;i+=paso){ const q=s.slice(i,i+paso); pts.push([X(q[q.length-1].t), Y(q.reduce((a,p)=>a+p.v,0)/q.length)]); }
  const ult=s[s.length-1], ex=X(ult.t), ey=Y(ult.v); pts[pts.length-1]=[ex,ey];
  const dd=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+" "+p[1].toFixed(1)).join("");
  g+=`<path class="g-area" d="${dd}L${ex.toFixed(1)} ${m.t+ih}L${pts[0][0].toFixed(1)} ${m.t+ih}Z"/><path class="g-lin" d="${dd}"/>`;
  g+=`<circle class="g-pto" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4"/><text class="g-fin" x="${(ex-8).toFixed(1)}" y="${Math.max(m.t+10,ey-9).toFixed(1)}" text-anchor="end">${ult.v.toFixed(w.d)} ${uni(k)}</text>`;
  let cur=null;
  if(sel.curT!=null){
    let bi=0, bd=Infinity; s.forEach((p,i)=>{ const q=Math.abs(p.t-sel.curT); if(q<bd){ bd=q; bi=i; } });
    cur=s[bi]; sel.curT=cur.t;
    const cx=X(cur.t).toFixed(1), cy=Y(cur.v).toFixed(1);
    g+=`<line class="g-cur" x1="${cx}" x2="${cx}" y1="${m.t}" y2="${m.t+ih}"/><circle class="g-pto" cx="${cx}" cy="${cy}" r="4"/>`;
  }
  svg.innerHTML=g;
  UG={s,tIni,span,m,iw};
  const tip=$("tip");
  if(!cur){ tip.hidden=true; return; }
  const nv=nivelDe(k,cur.b);
  tip.querySelector("b").textContent=cur.v.toFixed(w.d)+" "+uni(k);
  tip.querySelector(".sec").textContent=hora(cur.t)+(w.aviso!==undefined ? " · "+SIMB[nv]+" "+etq(k,nv) : "");
  tip.hidden=false;
  const x=X(cur.t), tw=tip.offsetWidth;
  tip.style.left=Math.max(2, x+14+tw>Wd ? x-14-tw : x+14)+"px"; tip.style.top=(m.t+4)+"px";
}
function dibujarTabla(){
  const k=sel.k, w=WID[k], s=serie(k,ventana()), cont=$("tablaV");
  cont.textContent="";
  if(!s.length){ cont.textContent="Aún no hay datos en esta ventana."; return; }
  const MAXF=60, idx=[];
  if(s.length<=MAXF) s.forEach((_,i)=>idx.push(i)); else for(let i=0;i<MAXF;i++) idx.push(Math.round(i*(s.length-1)/(MAXF-1)));
  const tb=document.createElement("table"), cap=document.createElement("caption");
  cap.className="d-sub"; cap.style.textAlign="left"; cap.textContent="Hasta 60 muestras de la ventana, las más recientes primero.";
  tb.appendChild(cap);
  const hr=tb.insertRow(); ["Hora","Valor","Estado"].forEach(t=>{ const th=document.createElement("th"); th.textContent=t; hr.appendChild(th); });
  idx.reverse().forEach(i=>{
    const p=s[i], tr=tb.insertRow(), nv=nivelDe(k,p.v);
    tr.insertCell().textContent=hora(p.t);
    tr.insertCell().textContent=fmt(k,p.v)+" "+uni(k);
    tr.insertCell().textContent = w.aviso===undefined ? "–" : SIMB[nv]+" "+etq(k,nv);
  });
  cont.appendChild(tb);
}

/* ---- gráfico: cursor con ratón, toque y teclado ---- */
function iniciarGrafico(){
  const gc=$("grafico");
  const pausar=()=>{ if(!sel.pausa){ sel.pausa=true; sel.nowF=Date.now(); } };
  const cursorX=cx=>{
    if(!UG) return; const r=$("gsvg").getBoundingClientRect();
    const t=UG.tIni+(cx-r.left-UG.m.l)/UG.iw*UG.span;
    sel.curT=Math.max(UG.s[0].t,Math.min(UG.s[UG.s.length-1].t,t)); dibujarGrafico();
  };
  gc.addEventListener("pointerenter",pausar);
  gc.addEventListener("pointermove",e=>{ pausar(); cursorX(e.clientX); });
  gc.addEventListener("pointerleave",()=>{ if(document.activeElement!==gc){ sel.pausa=false; sel.curT=null; dibujarGrafico(); } });
  gc.addEventListener("focus",()=>{ pausar(); if(sel.curT==null&&UG) sel.curT=UG.s[UG.s.length-1].t; dibujarGrafico(); });
  gc.addEventListener("blur",()=>{ sel.pausa=false; sel.curT=null; dibujarGrafico(); });
  gc.addEventListener("keydown",e=>{
    if(!UG) return; const s=UG.s; let i=s.findIndex(p=>p.t===sel.curT); if(i<0) i=s.length-1;
    if(e.key==="ArrowLeft") i=Math.max(0,i-1);
    else if(e.key==="ArrowRight") i=Math.min(s.length-1,i+1);
    else if(e.key==="Home") i=0; else if(e.key==="End") i=s.length-1;
    else if(e.key==="Escape"){ sel.curT=null; dibujarGrafico(); return; }
    else return;
    e.preventDefault(); sel.curT=s[i].t; dibujarGrafico();
  });
  addEventListener("resize",()=>{ if(!sel.tabla) dibujarGrafico(); });
}

/* ---- filtros, CSV y arranque de los widgets ---- */
function descargarCsv(){
  const cols=[["co","co_ppm"],["ch4","ch4_pct"],["o2","o2_pct"],["h2s","h2s_ppm"],["temp","temp_c"],["hum","hum_pct"],["pres","pres_hpa"],["rocio","rocio_c"],["bat","bat_pct"],["bat_v","bat_v"]];
  const fila=f=>[new Date(f.t).toISOString(), ...cols.map(([k])=>f[k]==null ? "" : +(+f[k]).toFixed(3))].join(",");
  const csv="﻿"+["hora_utc",...cols.map(c=>c[1])].join(",")+"\n"+HIST.map(fila).join("\n")+"\n";
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  a.download="robot-minero-"+new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")+".csv";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function iniciarWidgets(){
  CLAVES.forEach(k=>{ tiles[k]=crearTile(k); $(CONT[WID[k].grupo]).appendChild(tiles[k]); });
  $("segVentana").onclick=e=>{
    const b=e.target.closest("button"); if(!b) return;
    estado.rango=+b.dataset.r; [...$("segVentana").children].forEach(x=>x.setAttribute("aria-pressed",x===b));
    sel.curT=null; pintarWidgets();
  };
  $("segUni").onclick=e=>{
    const b=e.target.closest("button"); if(!b) return;
    estado.unidadF=b.dataset.u==="F"; [...$("segUni").children].forEach(x=>x.setAttribute("aria-pressed",x===b));
    sel.curT=null; pintarWidgets();
  };
  $("btnTabla").onclick=()=>{
    sel.tabla=!sel.tabla; $("btnTabla").setAttribute("aria-pressed",sel.tabla); $("btnTabla").textContent=sel.tabla?"Ver gráfico":"Ver tabla";
    $("grafico").hidden=sel.tabla; $("tablaV").hidden=!sel.tabla; sel.pausa=false; pintarDetalle(true);
  };
  $("btnEscala").onclick=()=>{
    sel.ajustada=!sel.ajustada; $("btnEscala").setAttribute("aria-pressed",sel.ajustada);
    $("btnEscala").textContent=sel.ajustada?"Escala completa":"Ajustar escala"; sel.curT=null; sel.pausa=false; pintarDetalle(true);
  };
  $("btnCsv").onclick=descargarCsv;
  const bh=$("bateria"); bh.tabIndex=0; bh.setAttribute("role","button"); bh.style.cursor="pointer";
  bh.onclick=()=>seleccionar("bat",true); bh.onkeydown=e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); seleccionar("bat",true); } };
  iniciarGrafico();
  if(DEMO){ $("demoBarra").hidden=false; precargarDemo(); }
  muestrear(); seleccionar("co",false); pintarWidgets();
  setInterval(()=>{ if(DEMO) demoPaso(); muestrear(); pintarWidgets(); },1000);
  setInterval(pintarNav,500);
}

/* ---- navegación: inclinación, rumbo y obstáculo frontal ---- */
const NAV = [
  {k:"inc",  n:"Inclinación",       u:"°", d:1, aviso:15, alerta:25},
  {k:"rumbo",n:"Rumbo",             u:"°", d:0},
  {k:"front",n:"Obstáculo frontal", u:"m", d:2, bajoAviso:1.0, bajoAlerta:0.4}
];
$("sensores").innerHTML=NAV.map(s=>`<div class="sensor" id="s_${s.k}"><span>${s.n}</span><b>--</b><small>${s.u}</small><em></em></div>`).join("");
function pintarNav(){
  const vivo = DEMO || Date.now()-estado.ultimoSensores<3000;
  NAV.forEach(s=>{
    const el=$("s_"+s.k), v=estado.datos[s.k];
    if((!vivo && s.k!=="front") || v==null){ el.querySelector("b").textContent="--"; el.querySelector("em").textContent=""; el.className="sensor"; return; }
    el.querySelector("b").textContent=(+v).toFixed(s.d);
    let nivel=0;
    if(s.alerta!==undefined){ if(v>=s.alerta) nivel=2; else if(v>=s.aviso) nivel=1; }
    if(s.bajoAlerta!==undefined){ if(v<=s.bajoAlerta) nivel=2; else if(v<=s.bajoAviso) nivel=1; }
    el.className="sensor "+["","aviso","alerta"][nivel];
    el.querySelector("em").textContent = (s.alerta!==undefined||s.bajoAlerta!==undefined) ? SIMB[nivel]+" "+["Normal","Precaución","Peligro"][nivel] : "";
  });
}

/* ========= SIMULACIÓN DE DATOS (solo en modo demo, sin robot) ========= */
const DEMO_BASE = {co:8, ch4:.2, o2:20.9, h2s:.5, temp:27, hum:70};
const demoObj = Object.assign({}, DEMO_BASE);
const DEMO_ESC = {normal:{}, co:{co:65}, ch4:{ch4:1.8}, o2:{o2:18.5}, h2s:{h2s:12}, calor:{temp:70}, bat:{}};
function demoPaso(rapido){
  const r=(a,b)=>a+Math.random()*(b-a), d=estado.datos;
  const sigue=(k,ruido,piso)=>{ const x=d[k]??demoObj[k]; d[k]=Math.max(piso??0, x+(demoObj[k]-x)*.55+r(-ruido,ruido)); };
  sigue("co",.8); sigue("ch4",.02); sigue("o2",.06,15); sigue("h2s",.15); sigue("temp",.12); sigue("hum",.8); d.hum=Math.min(100,d.hum);
  d.pres=1008+Math.sin(Date.now()/60000)*1.5+r(-.1,.1);
  d.bat=Math.max(0,(d.bat??88)-.05); d.bat_v=21+d.bat*.084;     // 7 celdas: 21 V vacía, 29.4 V llena
  d.inc=Math.abs(r(0,6)); d.rumbo=((d.rumbo??0)+r(-1,1)+360)%360;
  d.alerta=["co","ch4","o2","h2s","temp"].some(k=>nivelDe(k,d[k])===2) ? 1 : 0;
  estado.ultimoSensores=Date.now();
  if(rapido) return;
  mostrarAlerta(!!d.alerta);
  const pos=+$("pinzaPos").textContent, dif=estado.pinza-pos;
  $("pinzaPos").textContent=(pos+Math.sign(dif)*Math.min(Math.abs(dif),10)).toFixed(0);
}
function precargarDemo(){                                       // 5 minutos de historial para que los gráficos no arranquen vacíos
  estado.datos.bat=100; const t0=Date.now();
  for(let i=300;i>0;i--){ demoPaso(true); muestrear(t0-i*1000,true); }
}
document.addEventListener("click",e=>{
  const b=e.target.closest("[data-demo]"); if(!b) return;
  const esc=b.dataset.demo; Object.assign(demoObj,DEMO_BASE,DEMO_ESC[esc]);
  if(esc==="bat"){ estado.datos.bat=14; } else if(esc==="normal" && estado.datos.bat<30){ estado.datos.bat=88; }
});

/* ========= CÁMARAS ========= */
const camEls={}; document.querySelectorAll(".cam").forEach(c=>{
  camEls[c.dataset.id]=c;
  c.onclick=()=>ponerPrincipal(c.dataset.id);
  c.onkeydown=e=>{ if(e.key==="Enter") ponerPrincipal(c.dataset.id); };
});
function ponerPrincipal(id){ Object.entries(camEls).forEach(([k,c])=>c.classList.toggle("principal",k===id)); }
function marcarCam(id,ok){ camEls[id].classList.toggle("offline",!ok); }
["visual","flir"].forEach(id=>{
  const img=camEls[id].querySelector("img"), url=CONFIG.camaras[id];
  if(!url){ img.style.display="none"; return; }
  const cargar=()=>{ img.src=url+"&t="+Date.now(); };
  img.onload=()=>{ img.style.display="block"; marcarCam(id,true); };
  img.onerror=()=>{ img.style.display="none"; marcarCam(id,false); setTimeout(cargar,3000); };
  cargar();
});
function ajustar(cv){ const r=cv.getBoundingClientRect(),d=devicePixelRatio||1; if(cv.width!==Math.round(r.width*d)){cv.width=Math.round(r.width*d);cv.height=Math.round(r.height*d);} return [cv.getContext("2d"),cv.width,cv.height]; }

function mensajeCam(el,titulo,detalle){
  const [g,w,h]=ajustar(el.querySelector("canvas")), d=devicePixelRatio||1;
  g.fillStyle="#232a22"; g.fillRect(0,0,w,h); g.textAlign="center";
  g.fillStyle="#cfd6c4"; g.font=`700 ${16*d}px "Barlow Condensed",sans-serif`; g.fillText(titulo,w/2,h/2-4*d);
  g.fillStyle="#8e9c86"; g.font=`${12*d}px Barlow,sans-serif`; g.fillText(detalle,w/2,h/2+16*d); g.textAlign="left";
}
function dibujarVisual(t){
  if(NUBE){ mensajeCam(camEls.visual,"Video disponible en la red local","Abre el panel con ?host=IP_DE_LA_JETSON"); return; }
  const [g,w,h]=ajustar(camEls.visual.querySelector("canvas"));
  const f=g.createLinearGradient(0,0,0,h); f.addColorStop(0,"#252b24"); f.addColorStop(.5,"#4a4d41"); f.addColorStop(1,"#1d1f19");
  g.fillStyle=f; g.fillRect(0,0,w,h);
  g.strokeStyle="#6e7160"; g.lineWidth=2;
  for(let i=1;i<7;i++){ const k=((i+t/700)%7)/7, s=k*k; g.strokeRect(w/2-w*s*.5,h/2-h*s*.4,w*s,h*s*.8); }
  g.fillStyle="#b9c0ad"; g.font=`${14*(devicePixelRatio||1)}px Barlow,sans-serif`; g.fillText("Imagen simulada · configura CONFIG.camaras.visual",12,h-14);
}
function dibujarFlir(t){
  if(NUBE){ mensajeCam(camEls.flir,"Térmica en la red local","?host=IP_DE_LA_JETSON"); return; }
  const [g,w,h]=ajustar(camEls.flir.querySelector("canvas"));
  g.fillStyle="#1a0f3c"; g.fillRect(0,0,w,h);
  [[.35,.55,.28,"#ffe36a"],[.7,.4,.18,"#ff8a3d"],[.5,.7,.35,"#a02c6e"]].forEach(([x,y,r,c],i)=>{
    const cx=w*x+Math.sin(t/1800+i)*10, cy=h*y, R=Math.min(w,h)*r;
    const gr=g.createRadialGradient(cx,cy,0,cx,cy,R); gr.addColorStop(0,c); gr.addColorStop(1,"rgba(26,15,60,0)");
    g.fillStyle=gr; g.fillRect(0,0,w,h);
  });
  g.fillStyle="#fff"; g.font=`${13*(devicePixelRatio||1)}px Barlow,sans-serif`; g.fillText("Imagen simulada · configura CONFIG.camaras.flir",12,h-14);
}
function dibujarLidar(t){
  const [g,w,h]=ajustar(camEls.lidar.querySelector("canvas"));
  g.fillStyle="#232a22"; g.fillRect(0,0,w,h);
  const cx=w/2, cy=h/2, R=Math.min(w,h)/2-10, esc=R/CONFIG.lidarRangoMax, d=devicePixelRatio||1;
  g.strokeStyle="#3d4a3a"; g.lineWidth=1; g.fillStyle="#8e9c86"; g.font=`${11*d}px Barlow,sans-serif`;
  for(let m=3;m<=CONFIG.lidarRangoMax;m+=3){ g.beginPath(); g.arc(cx,cy,m*esc,0,7); g.stroke(); g.fillText(m+" m",cx+4,cy-m*esc-3); }
  g.beginPath(); g.moveTo(cx,cy-R); g.lineTo(cx,cy+R); g.moveTo(cx-R,cy); g.lineTo(cx+R,cy); g.stroke();
  let pts=[];
  if(estado.scan && Date.now()-estado.scanTs<2000){ const s=estado.scan, off=CONFIG.lidarOffsetGrados*Math.PI/180; s.ranges.forEach((r,i)=>{ if(r!==null&&isFinite(r)&&r>s.range_min&&r<=s.range_max) pts.push([s.angle_min+i*s.angle_increment+off,r]); }); }
  else if(DEMO) for(let i=0;i<360;i++){ const a=i*Math.PI/180; // túnel simulado: pasillo de 4 m x 10 m
    const r=Math.min(2/Math.max(Math.abs(Math.sin(a)),.001),5/Math.max(Math.abs(Math.cos(a)),.001),CONFIG.lidarRangoMax)+Math.sin(i*3+t/400)*.03; pts.push([a,r]); }
  g.fillStyle="#a9c79a";
  pts.forEach(([a,r])=>{ g.fillRect(cx-Math.sin(a)*r*esc-d,cy-Math.cos(a)*r*esc-d,2*d,2*d); });
  g.fillStyle="#e3d8bd"; g.beginPath(); g.moveTo(cx,cy-9*d); g.lineTo(cx+6*d,cy+7*d); g.lineTo(cx-6*d,cy+7*d); g.fill();
  const frente=pts.filter(([a])=>Math.abs(Math.atan2(Math.sin(a),Math.cos(a)))<.17).map(p=>p[1]);
  const fresco = DEMO || (estado.scan && Date.now()-estado.scanTs<2000);
  estado.datos.front = fresco ? (frente.length?Math.min(...frente):CONFIG.lidarRangoMax) : null;
}
function bucle(t){
  if(!CONFIG.camaras.visual) { dibujarVisual(t); marcarCam("visual",true); }
  if(!CONFIG.camaras.flir)   { dibujarFlir(t);   marcarCam("flir",true); }
  dibujarLidar(t);
  marcarCam("lidar", DEMO || Date.now()-estado.scanTs<2000);
  requestAnimationFrame(bucle);
}


/* ========= ARRANQUE ========= */

/* ========= MODO NUBE: sesión, sondeo del servidor y órdenes =========
   El navegador no habla con la Jetson: habla con la API (/api/*). La pasarela de la Jetson sube los datos
   a la API y baja las órdenes. Ver README. */
const ROL = {admin:"Administrador", operator:"Operador", observer:"Observador", blocked:"Bloqueado"};
const NOMBRE_EV = {co:"Monóxido de carbono (CO)", ch4:"Metano (CH₄)", o2:"Oxígeno (O₂)", h2s:"Sulfuro de hidrógeno (H₂S)", temp:"Temperatura", hum:"Humedad", bat:"Batería", state:"Estado del robot"};
const UNI_EV = {co:"ppm", ch4:"%", o2:"%", h2s:"ppm", temp:"°C", hum:"%", bat:"%"};
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let _redirigiendo = false;
const login = () => {
  if (_redirigiendo) return; _redirigiendo = true;
  try { sessionStorage.setItem("pyx_rebote", String(Date.now())); } catch (e) {}
  location.replace("/login?next=/dashboard");
};
const fhora = t => new Date(t).toLocaleString([], {day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});

let _ultToast = {m:"",t:0};
function toast(msg, tipo){
  if(msg===_ultToast.m && Date.now()-_ultToast.t<4000) return;
  _ultToast = {m:msg, t:Date.now()};
  const c=$("toasts"), el=document.createElement("div");
  el.className="toast "+(tipo||""); el.textContent=msg; el.setAttribute("role", tipo==="error"?"alert":"status");
  c.appendChild(el); setTimeout(()=>el.remove(), 5000);
}

async function enviarNube(cuerpo){
  try{
    const r = await fetch("/api/command", {method:"POST", credentials:"same-origin", headers:{"Content-Type":"application/json"}, body:JSON.stringify(Object.assign({robot:ROBOT}, cuerpo))});
    if(r.status===401){ login(); return null; }
    const j = await r.json().catch(()=>({}));
    if(!r.ok){ if(cuerpo.type!=="hb") toast(j.error||"No se pudo enviar la orden","error"); return null; }
    return j;
  }catch(e){ if(cuerpo.type!=="hb") toast("Sin conexión con el servidor","error"); return null; }
}

const _t = {cmd:0, hb:0, arm:0, grip:0};
function pubNube(n,m){
  const ahora=Date.now();
  if(n==="hb"){ if(!ROBOT || ahora-_t.hb<2000 || ausente()) return; _t.hb=ahora; enviarNube({type:"hb"}); return; }
  if(n==="estop"){ enviarNube({type:"estop"}).then(sondearNube); return; }
  if(SOLO_LECTURA || estado.estopNube) return;
  if(n==="cmdVel"){                                   // máximo 5 órdenes por segundo; el alto se envía siempre
    const lin=m.linear.x, ang=m.angular.z, alto=!lin && !ang;
    if(!alto && ahora-_t.cmd<200) return;
    _t.cmd=ahora; enviarNube({type:"drive", lin, ang});
  }
  else if(n==="modo") enviarNube({type:"mode", value:m.data==="automatico"?"auto":"manual"}).then(sondearNube);
  else if(n==="brazo"){ clearTimeout(_t.arm); _t.arm=setTimeout(()=>enviarNube({type:"arm", v:m.data}),150); }
  else if(n==="pinza"){ clearTimeout(_t.grip); _t.grip=setTimeout(()=>enviarNube({type:"grip", v:m.data}),150); }
}

let _oculto = 0;
document.addEventListener("visibilitychange",()=>{ _oculto = document.hidden ? Date.now() : 0; });
const ausente = () => document.hidden && Date.now()-_oculto>60000;   // pestaña oculta más de 1 min = el operador no está

function aplicarUsuario(){
  $("uNombre").textContent = USER.name + (USER.empresa ? " · " + USER.empresa : "");
  $("uRol").textContent = ROL[USER.role] || USER.role;
  $("uRol").dataset.rol = USER.role;
  SOLO_LECTURA = !USER.canControl;
  if(SOLO_LECTURA){
    $("btnManual").disabled = $("btnAuto").disabled = true;
    $("fsMando").disabled = $("fsPinza").disabled = $("fsBrazo").disabled = true;
    $("soloLectura").hidden = false;
  }
  if(USER.role==="admin" || USER.superadmin){ $("admin").hidden=false; cargarAdmin(); }
}
$("btnSalir") && ($("btnSalir").onclick = async ()=>{
  let url="/login";
  try{ const r=await fetch("/api/auth",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"logout"})}); url=(await r.json()).logoutUrl||url; }catch(e){}
  location.href=url;
});

/* ---- Sondeo de telemetría ---- */
let _primera = true, _sondeando = false;
async function sondearNube(){
  if(_sondeando || ausente()) return;
  _sondeando = true;
  try{
    const r = await fetch("/api/telemetry?robot="+(ROBOT||"")+(_primera?"&history=3600":""), {credentials:"same-origin", cache:"no-store"});
    if(r.status===401){ login(); return; }
    const j = await r.json();
    procesarNube(j);
    _primera = false;
  }catch(e){ conexion(false,"Sin conexión con el servidor"); }
  finally{ _sondeando = false; }
}

function procesarNube(j){
  const L = j.last, ahora = Date.now();
  if(!j.robot){ conexion(false, USER&&USER.role==="admin" ? "Registra tu robot en Administración (abajo)" : "Tu empresa aún no tiene robots"); return; }
  conexion(!!j.online, j.online ? "Robot en línea" : (L ? "Sin señal del robot" : "Esperando al robot"));
  if(_primera && j.history){
    HIST.length=0;
    j.history.forEach(h=>{ const f={t:h.t}; ["co","ch4","o2","h2s","temp","hum","pres","bat","bat_v"].forEach(k=>f[k]=h[k]==null?null:h[k]); f.rocio=rocio(f.temp,f.hum); HIST.push(f); });
  }
  // Parada de emergencia (enclavada en el servidor)
  const estop = !!(j.control && j.control.estop);
  estado.estopNube = estop;
  $("bannerEstop").hidden = !estop;
  if(estop){
    $("estopQuien").textContent = j.control.estopBy ? " Activada por "+j.control.estopBy+"." : "";
    $("btnLiberar").hidden = SOLO_LECTURA;
  }
  renderEventos(j.alerts||[]);

  if(!L || !j.online){ estado.datos.front=null; return; }
  const d = estado.datos;
  ["co","ch4","o2","h2s","temp","hum","pres","bat","bat_v","inc"].forEach(k=>{ d[k] = L[k]; });
  d.rumbo = L.heading; d.alerta = L.alert ? 1 : 0;
  estado.ultimoSensores = ahora;
  mostrarAlerta(!!d.alerta);
  bannerEstado({estado:L.state||"NORMAL", puntos:L.points||0});
  if(Array.isArray(L.lidar) && L.lidar.length){            // 72 sectores de 5°, el 0 al frente, sentido horario → LaserScan
    const n=L.lidar.length, inc=2*Math.PI/n, rg=[];
    for(let k=0;k<n;k++){ const a=-Math.PI+k*inc; const s=((Math.round(-a/inc)%n)+n)%n; const cm=L.lidar[s]; rg.push(cm>0 ? cm/100 : null); }
    estado.scan = {ranges:rg, angle_min:-Math.PI, angle_increment:inc, range_min:0.05, range_max:CONFIG.lidarRangoMax};
    estado.scanTs = ahora;
  }
  // Modo real (el que confirmó el robot) y brazo/pinza reales
  const modoReal = (j.control && j.control.estop) ? "manual" : (L.mode || j.control.mode);
  if(ahora-estado.cambioModo>2500){ const nuevo = modoReal==="auto" ? "automatico" : "manual"; if(nuevo!==estado.modo) ponerModo(nuevo,false); }
  if(Array.isArray(L.arm)){
    L.arm.forEach((v,i)=>{ if(ARM[i] && Number.isFinite(v)) $("real_"+ARM[i].k).textContent="real "+v.toFixed(0)+"°"; });
    if(!estado.armSync){ estado.armSync=true; ARM.forEach((a,i)=>{ if(!Number.isFinite(L.arm[i])) return; a.v=Math.round(L.arm[i]); $("in_"+a.k).value=a.v; $("out_"+a.k).textContent=a.v+"°"; }); dibujarBrazo(); }
  }
  if(L.grip!=null){
    $("pinzaPos").textContent = (+L.grip).toFixed(0);
    if(!estado.pinzaSync){ estado.pinzaSync=true; estado.pinza=Math.round(L.grip); $("pinza").value=estado.pinza; $("pinzaTxt").textContent=estado.pinza; }
  }
}
$("btnLiberar").onclick = ()=>enviarNube({type:"reset"}).then(()=>{ sondearNube(); toast("Parada de emergencia liberada","ok"); });

function bannerEstado(st){
  const b=$("banner2"); estado.robot=st;
  if(st.estado==="RTH"){ b.hidden=false; b.textContent="Sin señal de la estación base: el robot regresa solo a la base ("+Math.max(0,(st.puntos||1)-1)+" puntos por recorrer). La parada de emergencia cancela el retorno."; }
  else if(st.estado==="ESPERA"){ b.hidden=false; b.textContent="El robot está detenido y espera. Elige MANUAL o AUTOMÁTICO para continuar."; }
  else b.hidden=true;
}

/* ---- Eventos y alertas ---- */
function renderEventos(lista){
  const ol=$("listaEventos"); $("eventosVacio").hidden = lista.length>0;
  ol.innerHTML = lista.slice(0,12).map(a=>{
    const nom = NOMBRE_EV[a.key]||a.key, niv = a.level===2 ? "Peligro" : "Precaución", simb = a.level===2 ? "✖" : "▲";
    const val = a.key==="state" ? esc(a.value) : (a.value==null ? "" : esc(a.value)+" "+(UNI_EV[a.key]||""));
    return `<li class="ev n${a.level}"><span class="ev-s" aria-hidden="true">${simb}</span><span><b>${esc(nom)}</b> · ${a.key==="state" ? val : niv+" · "+val}<small>${fhora(a.t)}</small></span></li>`;
  }).join("");
}

/* ---- Administración (administrador de la empresa; solicitudes de demo solo para el equipo Pyxis-Bot) ---- */
const api = (ruta, cuerpo) => fetch(ruta, cuerpo===undefined ? {credentials:"same-origin"} :
  {method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(cuerpo)})
  .then(r=>r.json().catch(()=>({})).then(j=>(r.ok||toast(j.error||"No se pudo completar","error"), j)));
async function cargarRobots(){
  const j = await api("/api/robots"); const lista = j.robots||[];
  const sel=$("selRobot");
  sel.innerHTML = lista.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join("");
  if(!lista.some(r=>r.id===ROBOT)) ROBOT = lista.length ? lista[0].id : null;
  sel.value = ROBOT||""; sel.hidden = lista.length<2;
  if($("tRobots")) $("tRobots").innerHTML = lista.length ? "<thead><tr><th>Robot</th><th>Último dato</th><th></th></tr></thead><tbody>"+
    lista.map(r=>`<tr><td><b>${esc(r.nombre)}</b><small>ID ${r.id}</small></td><td>${r.visto?fhora(r.visto):"—"}</td><td><button type="button" class="btn-sec peq" data-borrar="${r.id}">Eliminar</button></td></tr>`).join("")+"</tbody>"
    : "<tbody><tr><td>Aún no hay robots. Registra uno y copia su clave en la Jetson (CLOUD_KEY).</td></tr></tbody>";
}
$("selRobot").onchange = e=>{ ROBOT=Number(e.target.value); _primera=true; estado.armSync=estado.pinzaSync=false; sondearNube(); };
async function cargarAdmin(){
  if(USER.role==="admin"){
    const u = await api("/api/users");
    if(u.ok){
      $("tUsuarios").innerHTML = "<thead><tr><th>Usuario</th><th>Último acceso</th><th>Rol</th></tr></thead><tbody>"+
        u.users.map(x=>`<tr data-s="${esc(x.sub)}"><td><b>${esc(x.name)}</b><small>${esc(x.email)}</small></td><td>${x.lastLogin?fhora(x.lastLogin):"—"}</td>
        <td><select aria-label="Rol de ${esc(x.name)}">${Object.keys(ROL).map(r=>`<option value="${r}"${r===x.role?" selected":""}>${ROL[r]}</option>`).join("")}</select></td></tr>`).join("")+
        u.invitaciones.map(x=>`<tr><td><b>${esc(x.email)}</b><small>Invitación pendiente</small></td><td>—</td><td>${ROL[x.role]} <button type="button" class="btn-sec peq" data-reenviar="${esc(x.email)}" data-rol="${x.role}">Reenviar</button> <button type="button" class="btn-sec peq" data-cancelar="${esc(x.email)}">Cancelar</button></td></tr>`).join("")+"</tbody>";
      $("lAudit").innerHTML = u.audit.map(a=>`<li><b>${esc(a.accion)}</b> · ${esc(a.quien)} <small>${esc(a.detalle)} · ${fhora(a.t)}</small></li>`).join("") || "<li>Sin actividad registrada</li>";
    }
  }else ["tRobots","fRobot","tUsuarios","fInvitar","lAudit"].forEach(id=>$(id).closest(".admin-g > div").hidden=true);
  if(USER.superadmin){
    const l = await api("/api/lead");
    $("bLeads").hidden = false;
    $("tLeads").innerHTML = l.leads && l.leads.length ? "<thead><tr><th>Fecha</th><th>Contacto</th><th>Sector</th><th>Mensaje</th></tr></thead><tbody>"+
      l.leads.map(x=>`<tr><td>${fhora(x.t)}</td><td><b>${esc(x.name)}</b><small>${esc(x.company)} · <a href="mailto:${esc(x.email)}">${esc(x.email)}</a></small></td><td>${esc(x.sector)}</td><td>${esc(x.message)}</td></tr>`).join("")+"</tbody>" : "<tbody><tr><td>Aún no hay solicitudes de demo.</td></tr></tbody>";
  }
}
$("tUsuarios").addEventListener("change", async e=>{
  const sel=e.target.closest("select"); if(!sel) return;
  const j = await api("/api/users", {sub:sel.closest("tr").dataset.s, role:sel.value});
  if(j.ok) toast("Rol actualizado","ok");
  cargarAdmin();
});
$("tUsuarios").addEventListener("click", async e=>{
  const r=e.target.closest("[data-reenviar]"); if(!r) return;
  const j = await api("/api/users", {invitar:r.dataset.reenviar, role:r.dataset.rol});
  if(j.ok) toast(j.correo ? "Invitación reenviada" : "No se pudo enviar el correo", j.correo?"ok":"error");
});
$("tUsuarios").addEventListener("click", async e=>{
  const b=e.target.closest("[data-cancelar]"); if(!b) return;
  await api("/api/users", {cancelar:b.dataset.cancelar}); cargarAdmin();
});
$("fInvitar").addEventListener("submit", async e=>{
  e.preventDefault(); const f=e.target;
  const j = await api("/api/users", {invitar:f.email.value, role:f.role.value});
  if(j.ok){ toast(j.correo ? "Invitación enviada por correo a "+f.email.value : "Invitación creada, pero no se pudo enviar el correo. Avísale que entre con ese correo","ok"); f.reset(); cargarAdmin(); }
});
$("fRobot").addEventListener("submit", async e=>{
  e.preventDefault(); const f=e.target;
  const j = await api("/api/robots", {nombre:f.nombre.value});
  if(j.ok){
    const p=$("claveNueva"); p.hidden=false;
    p.textContent = `Clave de "${j.robot.nombre}" (cópiala ahora, no se vuelve a mostrar): ${j.robot.clave}`;
    f.reset(); await cargarRobots(); cargarAdmin();
  }
});
$("tRobots").addEventListener("click", async e=>{
  const b=e.target.closest("[data-borrar]"); if(!b) return;
  if(!confirm("¿Eliminar este robot y todos sus datos? Su clave dejará de funcionar.")) return;
  const j = await api("/api/robots", {borrar:Number(b.dataset.borrar)});
  if(j.ok){ toast("Robot eliminado","ok"); await cargarRobots(); _primera=true; sondearNube(); }
});

/* ========= ARRANQUE ========= */
async function arrancar(){
  setInterval(()=>pub("hb",{data:true}),500);
  if(NUBE){
    try{
      const r = await fetch("/api/auth",{credentials:"same-origin",cache:"no-store"});
      if(r.status===401){ login(); return; }
      const j = await r.json().catch(()=>({}));
      if(!r.ok){ toast(j.error||"El servidor no respondió correctamente","error"); conexion(false,"Servidor sin configurar"); return; }
      USER = j.user;
      if(USER.empresaId==null){ location.replace("/login"); return; }   // falta registrar la empresa
      await cargarRobots();
    }catch(e){ toast("Sin conexión con el servidor","error"); }
    if(USER) aplicarUsuario();
    $("usuario").hidden=false;
    conexion(false,"Conectando con el servidor…");
  }else if(DEMO){
    $("bannerDemo").hidden=false;
    conexion(false,"Modo demo (sin robot)");
  }else conexion(false,"Conectando con la Jetson ("+HOST+")…");
  iniciarROS(); ponerModo("manual",false); ponerBrazo("casa",false); iniciarWidgets(); bucle(0);
  if(NUBE){ sondearNube(); setInterval(sondearNube, 1000); }
}
arrancar();
