"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  // Menú móvil
  var mb = $("menuB"), nav = $("nav");
  mb.addEventListener("click", function () { var a = nav.classList.toggle("abierto"); mb.setAttribute("aria-expanded", String(a)); });
  nav.addEventListener("click", function (e) { if (e.target.tagName === "A") { nav.classList.remove("abierto"); mb.setAttribute("aria-expanded", "false"); } });

  // Lecturas de ejemplo (simuladas) que varían suavemente
  if (!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    var t = 0;
    setInterval(function () {
      t += 1;
      $("vCO").firstChild.nodeValue = String(Math.round(8 + 3 * Math.sin(t / 5)));
      $("vCH4").firstChild.nodeValue = (0.3 + 0.1 * Math.sin(t / 7)).toFixed(1);
      $("vO2").firstChild.nodeValue = (20.8 + 0.1 * Math.sin(t / 9)).toFixed(1);
      $("vH2S").firstChild.nodeValue = String(Math.max(0, Math.round(1 + Math.sin(t / 6))));
    }, 1500);
  }

  // Formulario de solicitud de demo
  var f = $("formLead");
  function msg(txt, tipo) { var m = $("leadMsg"); m.hidden = !txt; m.className = "msg " + (tipo || "err"); m.textContent = txt || ""; }
  f.addEventListener("submit", function (e) {
    e.preventDefault(); msg("");
    var email = $("lCorreo").value.trim();
    if ($("lNombre").value.trim().length < 2) { msg("Escribe tu nombre."); $("lNombre").focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg("Escribe un correo válido."); $("lCorreo").focus(); return; }
    if (!$("lConsent").checked) { msg("Debes autorizar el tratamiento de tus datos para poder contactarte."); $("lConsent").focus(); return; }
    var b = $("lEnviar"), tx = b.textContent; b.disabled = true; b.textContent = "Enviando…";
    fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      name: $("lNombre").value.trim(), email: email, company: $("lEmpresa").value.trim(), sector: $("lSector").value,
      message: $("lMensaje").value.trim(), website: $("lWeb").value, consent: true }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (x.ok) { f.reset(); msg("¡Gracias! Recibimos tu solicitud y te escribiremos pronto.", "ok"); }
        else msg((x.d && x.d.error) || "No se pudo enviar. Inténtalo de nuevo.");
        b.disabled = false; b.textContent = tx;
      })
      .catch(function () { msg("Sin conexión. Inténtalo de nuevo en unos minutos."); b.disabled = false; b.textContent = tx; });
  });
})();
