# BLACKVOW Lovense Connector

Un conector privado de Lovense para ChatGPT y otros clientes MCP. Está pensado para una sola dueña por despliegue: detecta varios dispositivos, adapta las funciones a cada modelo y solo puede actuar sobre juguetes encendidos y conectados a su Lovense Remote.

> Proyecto comunitario independiente. No está afiliado, patrocinado ni aprobado por Lovense.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/lovense-connector-for-chatgpt?utm_medium=integration&utm_source=template&utm_campaign=lovense-chatgpt-connector)

¿Es tu primera vez? Sigue la **[guía completa paso a paso](GUIA_PASO_A_PASO.md)**: empieza creando la cuenta de Lovense Developer y termina con una prueba segura desde ChatGPT.

## La experiencia para la usuaria

1. Pulsa **Deploy on Railway** en la plantilla publicada.
2. Pega su `LOVENSE_DEVELOPER_TOKEN`, escribe exactamente el **Website Name** de su panel Lovense Developer y elige una contraseña privada como `OWNER_SECRET`; Railway genera las demás claves.
3. Abre el dominio que Railway le entrega e introduce la misma contraseña.
4. Pulsa **Crear código QR** y lo escanea desde Lovense Remote.
5. Copia la URL `/mcp` en ChatGPT. ChatGPT abre OAuth y pide la Owner Key una sola vez.
6. Para usarlo cualquier día, enciende el juguete, conéctalo a Lovense Remote y pídeselo a la IA.

**PARAR TODO / RED** y la herramienta `lovense_stop_all` detienen y limpian todos los dispositivos inmediatamente.

## Funciones

- Descubrimiento en vivo de uno o varios juguetes conectados.
- Selección siempre explícita por alias (`lush`, `spinel`) o ID; nunca se omite el dispositivo por accidente.
- Vibración, rotación, bombeo, thrust, fingering, succión, profundidad, stroke y oscilación cuando el dispositivo los admite.
- Patrones personalizados y presets oficiales: `pulse`, `wave`, `fireworks` y `earthquake`.
- Ajustes relativos seguros desde el último nivel explícito conocido.
- Sesiones coordinadas con una pista independiente por dispositivo: Lush y Spinel pueden seguir curvas distintas en el mismo reloj.
- Ventana predeterminada de sesión en vivo de una hora (**default one-hour live-session window**), ampliable hasta 120 minutos y ejecutada por el servidor entre turnos del chat. Es el sobre temporal de una partitura que puede repetirse y cambiar, no una orden inmóvil durante una hora.
- Ajuste y extensión sin introducir una parada intencional; `hold` detiene la salida pero conserva la partitura.
- Vista previa seca que valida y muestra el mapeo completo sin enviar ninguna orden física.
- Techos opcionales por dispositivo/canal; el valor predeterminado real es 100%, por lo que 20/20 llega al máximo permitido por Lovense Remote.
- Tres interrupciones separadas: conservar sesión, detener un dispositivo, o detener y limpiar todo.
- Batería, conexión, nombre, apodo y capacidades por dispositivo.
- Metadatos separados para canales controlables por la API, funciones manuales/de app y procedencia de capacidades; nunca presentan Heat o Turbo como órdenes enviadas por BLACKVOW.
- OAuth 2.1 con PKCE para ChatGPT.
- Validación de dispositivo, función e intensidad antes de cada orden.
- Órdenes con duración elegida por la usuaria, incluyendo `0` para continuar hasta que diga que pare.
- Parada de emergencia y orden de parada al cerrar el servidor.
- Estado de dispositivos cifrado con AES-256-GCM.
- Sin analítica, anuncios ni base de datos compartida.

La lista y los rangos proceden de la [Standard API oficial de Lovense](https://developer.lovense.com/docs/standard-solutions/standard-api). El servidor usa primero las funciones que el dispositivo anuncia en vivo y solo recurre a un catálogo conservador cuando esa información no llega por el socket.

## Modelo de sesión en vivo

`durationSeconds` es opcional en `lovense_preview` y `lovense_live_start`. Si se omite, BLACKVOW usa la **default one-hour live-session window** de 3600 segundos. Esta duración es un sobre de sesión: cada dispositivo conserva una pista independiente cuyo ciclo puede repetirse, interpolarse y ajustarse entre mensajes mediante `lovense_live_adjust`. No significa que el servidor envíe una única intensidad sin cambios durante una hora.

Las pruebas breves deben proporcionar siempre una duración explícita. La sesión completa nunca puede superar 7200 segundos, incluso después de extensiones. `resumeOnReconnect` vale `false` por defecto: una desconexión pone la sesión en hold y no existe reinicio silencioso. `lovense_resume` exige consentimiento activo nuevo y que todos los objetivos vuelvan a estar conectados.

Cada dispositivo tiene una sola pista y cada pista exige un alias estable o ID explícito. Las pistas comparten reloj, pero sus pasos y canales son independientes. Una respuesta `accepted` o `queued` solo describe la aceptación técnica de la orden; la Standard API no confirma movimiento físico. La confirmación corporal o visual debe reportarse por separado.

## Lo que hace cada juguete

| Familia/modelo | Funciones de control usadas como fallback |
| --- | --- |
| Ferri, Lush, Hush, Domi, Gemini, Flexer, Mission, Dolce, Ambi, Lapis, Exomoon, Hyphy | Vibrate |
| Nora, Ridge | Vibrate + Rotate |
| Max / Max 2 | Vibrate + Pump |
| Tenera / Tenera 2 | Suction |
| Osci | Vibrate + Fingering |
| Gush 2 | Vibrate + Oscillate |
| Velvo | Vibrate + Rotate + Oscillate |
| Vulse | Vibrate + Thrusting |
| Solace, Solace Pro, Gravity y Lovense Sex Machine | Thrusting + Stroke + Depth |
| Spinel | Vibrate + Thrusting; además exige declarar `straight` o `g_curve` antes del control |
| Edge y Synth | Vibrate |

Con Spinel, `straight` permite `Vibrate` y `Thrusting`; `g_curve` permite solo `Thrusting`. El producto también ofrece calor y Turbo en la app, pero BLACKVOW no los expone porque `Heat` y Turbo no figuran entre las acciones ordinarias documentadas de la Standard API. El descubrimiento los muestra únicamente en `manualOrAppFeatures`, siempre con `blackvowControllable: false`; no se adivina compatibilidad de Turbo por accesorio. Consulta [docs/DEVICE_CAPABILITIES.md](docs/DEVICE_CAPABILITIES.md).

## Desarrollo local

Requiere Node.js 20 o posterior y un token del [panel de Lovense Developer](https://www.lovense.com/developer/).

```powershell
Copy-Item .env.example .env
# Rellena .env con cuatro secretos distintos y tu token de Lovense.
npm install
npm run check
npm test
npm run build
npm start
```

El proceso no carga `.env` automáticamente. En desarrollo, importa esas variables en la terminal o usa el gestor de entorno que prefieras. En Railway se inyectan desde **Variables**.

## Variables de Railway

| Variable | Quién la proporciona | Descripción |
| --- | --- | --- |
| `LOVENSE_DEVELOPER_TOKEN` | La usuaria | Token privado de su proyecto Lovense Developer. Nunca va al navegador. |
| `LOVENSE_PLATFORM_NAME` | La usuaria | El **Website Name** exacto que aparece en ese mismo proyecto de Lovense Developer. |
| `OWNER_SECRET` | La usuaria | Contraseña que la dueña elige para abrir el panel y aprobar OAuth. |
| `MCP_PATH_SECRET` | Railway: `${{secret(48)}}` | Acceso alternativo para clientes MCP sin OAuth. No se muestra en el panel. |
| `OAUTH_SIGNING_KEY` | Railway: `${{secret(64)}}` | Firma códigos y tokens OAuth. Rotarla revoca todos los enlaces. |
| `STATE_ENCRYPTION_KEY` | Railway: `${{secret(64)}}` | Cifra el estado guardado. Si cambia, hay que volver a escanear el QR. |
| `LOVENSE_UID` | Railway: `${{secret(16)}}` | Identificador privado y estable de esta instancia. |
| `PORT` | Plantilla | `8080`, el puerto interno que Railway usa también para comprobar que el servicio está listo. |
| `STATE_FILE` | Plantilla | `/data/lovense-state.enc` cuando la plantilla adjunta un volumen. |

Variable opcional: `MAX_COMMAND_SECONDS` (7200; rango permitido 2–7200) limita una duración numérica accidentalmente enorme. Las sesiones en vivo usan 3600 segundos por defecto y pueden ampliarse hasta ese techo de dos horas. Un despliegue puede elegir un límite más estricto; en ese caso también acorta la ventana omitida. El valor `0` sigue significando “hasta que la usuaria diga que pare” para las herramientas directas compatibles.

## Plantilla de Railway

La [plantilla pública](https://railway.com/deploy/lovense-connector-for-chatgpt?utm_medium=integration&utm_source=template&utm_campaign=lovense-chatgpt-connector) ya incluye red pública y puerto compatibles, un endpoint `/health`, volumen persistente en `/data`, secretos automáticos e instrucciones bilingües. La usuaria solo tiene que proporcionar el token, copiar el **Website Name** exacto de su proyecto Lovense y elegir su contraseña privada.

Para una instalación desde cero, consulta la [guía completa para principiantes](GUIA_PASO_A_PASO.md).

Railway recomienda generar secretos en la plantilla, describir cada variable y configurar un health check. Véase [Create a Template](https://docs.railway.com/templates/create) y [Template Best Practices](https://docs.railway.com/templates/best-practices).

## Herramientas MCP

- `lovense_status`: conexión y estado veraz de la sesión.
- `lovense_list_devices`: cada dispositivo, alias estable, batería, conexión, `apiChannels`, `supportedChannels` (alias de compatibilidad), `manualOrAppFeatures`, fuente/verificación, accesorio y techos.
- `lovense_configure_device`: declara alias, accesorio Spinel y techos; no mueve ningún dispositivo.
- `lovense_preview`: valida una sesión coordinada y muestra el mapeo sin salida física; `dryRun` no envía ninguna orden.
- `lovense_live_start`: inicia una pista independiente por dispositivo sobre un reloj sincronizado; usa la ventana predeterminada de una hora y nunca supera dos horas.
- `lovense_live_status`: objetivos, niveles ordenados, aceptación de despacho, conexión, batería, hold y reloj.
- `lovense_live_adjust`: cambia canales concretos de dispositivos concretos sin reiniciar el reloj.
- `lovense_live_extend`: amplía la sesión sin superar dos horas.
- `lovense_hold`: envía Stop pero conserva la sesión.
- `lovense_resume`: reanuda solo con consentimiento nuevo y dispositivos conectados; `resumeOnReconnect` es `false` por defecto.
- `lovense_stop_device`: detiene y elimina una pista concreta.
- `lovense_stop_all`: parada RED de todo y limpieza de la sesión.

Las acciones publicadas son estrictas: `Vibrate`, `Rotate`, `Thrusting`, `Fingering`, `Suction` y `Oscillate` requieren un entero `intensity` de 0–20; `Pump` y `Depth`, de 0–3; `Stroke` requiere `strokeMin` y `strokeMax` entre 0–100 con al menos 20 puntos de separación y no acepta `intensity`. Los campos irrelevantes se rechazan antes de llegar al runtime, que vuelve a validar rangos, canal y accesorio como defensa en profundidad.

## Seguridad y privacidad

Lee [SECURITY.md](SECURITY.md) antes de publicar o modificar autenticación. La instancia usa OAuth para ChatGPT, pero conserva una ruta secreta opcional para clientes que todavía no soportan OAuth. Esa URL alternativa debe tratarse como una contraseña.

## Licencia

MIT. Consulta [LICENSE](LICENSE).
