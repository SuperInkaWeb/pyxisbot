# Historial de versiones

## 2.1.0 · 2026-11-12
- Repositorio organizado por aplicación: `plataforma/` (frontend, backend, api, pruebas) y `robot/` (esp32, jetson).
- Invitaciones por correo con Resend: rol, empresa, quién invita y enlace de acceso; botón Reenviar.
- Firmware ESP32 con `platformio.ini` y sus librerías.
- Eliminado código sin uso (panel local antiguo, firmware duplicado, guía de Redis, script de marca).

## 2.0.0 · 2026-11-11
- Inicio de sesión con Auth0 (sin contraseñas propias).
- Base de datos Neon (PostgreSQL) en lugar de Upstash Redis.
- Multiempresa: datos aislados por empresa; invitaciones con correo verificado; clave propia por robot.
- Solicitudes de demo visibles solo para el superadministrador (`SUPERADMIN_EMAILS`).

## 1.0.0 · 2026-11-09
- Página comercial, panel de control y API en Vercel con Upstash Redis.
- Firmware ESP32 y nodos ROS 2 de la Jetson (puente, cámara térmica, pasarela a la nube).
