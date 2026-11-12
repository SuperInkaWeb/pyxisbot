"use strict";
// Inicio de sesión con Auth0 (los botones van a /api/auth?login) y registro de la empresa del usuario.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  function msg(texto, tipo) {
    var m = $("mensaje");
    m.hidden = !texto; m.className = "msg " + (tipo || "err"); m.textContent = texto || "";
  }
  function json(r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, s: r.status, d: d }; }); }
  function post(cuerpo) {
    return fetch("/api/auth", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) }).then(json);
  }
  if (q.get("error")) msg(q.get("error"));

  fetch("/api/auth", { credentials: "same-origin", cache: "no-store" }).then(json).then(function (x) {
    if (x.s === 503) { msg(x.d.error || "El servidor no está configurado todavía."); return; }
    if (!x.ok || !x.d.user) return;                       // sin sesión: se quedan los botones de Auth0
    if (x.d.user.empresaId != null) { location.replace("/dashboard"); return; }
    $("pasoEntrar").hidden = true; $("pasoEmpresa").hidden = false;
    $("quien").textContent = x.d.user.name;
    $("empresa").focus();
  }).catch(function () { msg("Sin conexión con el servidor."); });

  $("pasoEmpresa").addEventListener("submit", function (e) {
    e.preventDefault(); msg("");
    var nombre = $("empresa").value.trim();
    if (nombre.length < 2) { msg("Escribe el nombre de la empresa."); return; }
    if (!$("terminos").checked) { msg("Debes aceptar los términos y la política de privacidad."); return; }
    post({ action: "empresa", nombre: nombre }).then(function (x) {
      if (x.ok) location.replace("/dashboard"); else msg(x.d.error || "No se pudo registrar la empresa.");
    });
  });
  $("reintentar").onclick = function (e) { e.preventDefault(); location.reload(); };
  $("salir").onclick = function () {
    post({ action: "logout" }).then(function (x) { location.href = x.d.logoutUrl || "/login"; });
  };
})();
