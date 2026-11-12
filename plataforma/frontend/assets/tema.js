/* Modo claro / oscuro de Pyxis-Bot.
   - Se carga en el <head> (sin defer) para aplicar el tema antes de pintar y evitar el destello blanco.
   - Recuerda la elección en este navegador; si nunca se eligió, sigue la preferencia del sistema.
   - Cualquier botón con el atributo data-tema-toggle alterna el tema. */
(function () {
  "use strict";
  var CLAVE = "pyx_tema", raiz = document.documentElement;

  function preferido() {
    try { var v = localStorage.getItem(CLAVE); if (v === "oscuro" || v === "claro") return v; } catch (e) {}
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro";
  }

  function aplicar(t) {
    raiz.setAttribute("data-tema", t);
    raiz.style.colorScheme = t === "oscuro" ? "dark" : "light";
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) { if (!m.dataset.claro) m.dataset.claro = m.content; m.content = t === "oscuro" ? "#121611" : m.dataset.claro; }
    var bs = document.querySelectorAll("[data-tema-toggle]");
    for (var i = 0; i < bs.length; i++) {
      var osc = t === "oscuro";
      bs[i].setAttribute("aria-pressed", String(osc));
      bs[i].setAttribute("aria-label", osc ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
      bs[i].title = osc ? "Modo claro" : "Modo oscuro";
    }
    try { document.dispatchEvent(new CustomEvent("pyx:tema", { detail: t })); } catch (e) {}
  }

  aplicar(preferido());

  document.addEventListener("DOMContentLoaded", function () {
    aplicar(raiz.getAttribute("data-tema"));
    var bs = document.querySelectorAll("[data-tema-toggle]");
    for (var i = 0; i < bs.length; i++) bs[i].addEventListener("click", function () {
      var t = raiz.getAttribute("data-tema") === "oscuro" ? "claro" : "oscuro";
      try { localStorage.setItem(CLAVE, t); } catch (e) {}
      aplicar(t);
    });
  });

  // Si la persona nunca eligió, acompaña los cambios del sistema (p. ej. modo nocturno automático)
  if (window.matchMedia) {
    var mq = matchMedia("(prefers-color-scheme: dark)"), alCambiar = function (e) {
      try { if (localStorage.getItem(CLAVE)) return; } catch (x) {}
      aplicar(e.matches ? "oscuro" : "claro");
    };
    if (mq.addEventListener) mq.addEventListener("change", alCambiar); else if (mq.addListener) mq.addListener(alCambiar);
  }
})();
