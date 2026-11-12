/* Fondo animado tipo radar/LiDAR. Respeta prefers-reduced-motion (dibuja un solo cuadro). */
(function () {
  "use strict";
  var c = document.getElementById("fondo");
  if (!c || !c.getContext) return;
  var g = c.getContext("2d"), W = 0, H = 0, D = 1, t0 = 0;
  var quieto = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var pts = [];
  function medir() {
    D = Math.min(window.devicePixelRatio || 1, 2);
    var r = c.getBoundingClientRect(); W = r.width; H = r.height;
    c.width = Math.round(W * D); c.height = Math.round(H * D);
    g.setTransform(D, 0, 0, D, 0, 0);
    pts = [];
    for (var i = 0; i < 90; i++) {            // "paredes" de la galería: puntos que el barrido ilumina
      var a = Math.random() * Math.PI * 2, r0 = 0.18 + Math.random() * 0.34;
      var wob = 1 + 0.12 * Math.sin(a * 5) + 0.07 * Math.sin(a * 11 + 1);
      pts.push({ a: a, r: r0 * wob + 0.12 });
    }
  }
  function cuadro(ms) {
    var t = (ms - t0) / 1000, cx = W * 0.72, cy = H * 0.5, R = Math.max(W, H) * 0.7;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1;
    for (var k = 1; k <= 5; k++) {
      g.strokeStyle = "rgba(169,199,154," + (0.05 + 0.02 * (5 - k)) + ")";
      g.beginPath(); g.arc(cx, cy, R * k / 5 * 0.6, 0, 7); g.stroke();
    }
    g.strokeStyle = "rgba(169,199,154,.06)";
    for (var q = 0; q < 12; q++) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(q * Math.PI / 6) * R, cy + Math.sin(q * Math.PI / 6) * R); g.stroke(); }
    var barrido = (t * 0.9) % (Math.PI * 2);
    if (!quieto) {
      var grad = g.createConicGradient ? g.createConicGradient(barrido - 1.1, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, "rgba(169,199,154,0)"); grad.addColorStop(0.17, "rgba(169,199,154,.28)"); grad.addColorStop(0.1750, "rgba(169,199,154,0)");
        g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R * 0.62, 0, 7); g.fill();
      }
      g.strokeStyle = "rgba(169,199,154,.6)";
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(barrido) * R * 0.62, cy + Math.sin(barrido) * R * 0.62); g.stroke();
    }
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], d = quieto ? 0.4 : ((barrido - p.a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      var br = quieto ? 0.55 : Math.max(0, 1 - d / 3.2);
      if (br <= 0.02) continue;
      g.fillStyle = "rgba(169,199,154," + (0.15 + br * 0.8).toFixed(2) + ")";
      var rr = p.r * Math.min(W, H) * 0.95;
      g.beginPath(); g.arc(cx + Math.cos(p.a) * rr, cy + Math.sin(p.a) * rr, 2.2, 0, 7); g.fill();
    }
    g.fillStyle = "#a9c79a"; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fill();
    if (!quieto && !document.hidden) requestAnimationFrame(cuadro);
  }
  medir();
  window.addEventListener("resize", function () { medir(); if (quieto) cuadro(0); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !quieto) requestAnimationFrame(cuadro); });
  requestAnimationFrame(function (ms) { t0 = ms; cuadro(ms); });
})();
