# Capacidades de dispositivos

## Fuente de verdad

El conector decide las capacidades en este orden:

1. `fullFunctionNames` o `shortFunctionNames` anunciados por el dispositivo.
2. Catálogo conservador por `toyType`/nombre.
3. Estado `unknown`: la interfaz lo muestra, pero BLACKVOW rechaza el control hasta recibir capacidades reales; nunca prueba una función sobre el cuerpo para descubrirla.

Esto evita asumir que todos los Lovense vibran o que dos revisiones de hardware son idénticas.

`lovense_list_devices` publica esta separación de forma estructurada:

| Campo | Significado |
| --- | --- |
| `apiChannels` | Canales que BLACKVOW puede validar y despachar por la interfaz de desarrollador. |
| `supportedChannels` | Alias de compatibilidad de `apiChannels`; no incluye funciones exclusivas de la app. |
| `manualOrAppFeatures` | Funciones conocidas del producto que BLACKVOW no puede despachar. Cada entrada declara `blackvowControllable: false`. |
| `capabilitySource` | `device` si el juguete anunció los canales, `catalog` si proceden del fallback conservador, o `unknown`. |
| `verificationState.apiChannels` | Expone esa procedencia como `announced`, `catalog` o `unknown`. |
| `verificationState.physicalDelivery` | Siempre `not_recorded_by_connector`: una aceptación técnica no se convierte en confirmación física. |

## Acciones y rangos de la Standard API

| Acción | Rango |
| --- | --- |
| Vibrate | 0–20 |
| Rotate | 0–20 |
| Pump | 0–3 |
| Thrusting | 0–20 |
| Fingering | 0–20 |
| Suction | 0–20 |
| Depth | 0–3 |
| Stroke | 0–100; se usa junto a Thrusting y necesita al menos 20 puntos entre mínimo y máximo |
| Oscillate | 0–20 |

Lovense Remote 7.71.0 o posterior acepta una matriz de IDs. El conector envía una orden por juguete para conservar compatibilidad con versiones anteriores y permitir selecciones múltiples.

## Spinel y accesorios

- `straight`: BLACKVOW permite `Thrusting` y `Vibrate`, juntos o por separado.
- `g_curve`: BLACKVOW permite solo `Thrusting`.
- Heat aparece solo como metadata manual/de app: `straight` se marca `supported`, `g_curve` se marca `unsupported`, y `blackvowControllable` permanece `false`.
- Turbo aparece solo como metadata manual/de app. Su compatibilidad por accesorio se marca `unverified`; BLACKVOW no la adivina.
- La página oficial del producto atribuye calentamiento al accesorio recto, pero la Standard API no documenta una acción `Heat`; por eso BLACKVOW no la fabrica, imita ni reporta como despachada.
- Turbo se mantiene fuera de la superficie de acciones hasta que exista una ruta real compatible que se pueda validar y detener de forma independiente.
- Cada canal usa 100% de techo por defecto. Un techo configurado menor escala 0–20 dentro de ese porcentaje; nunca aumenta por encima de la salida permitida por Lovense Remote.

## Límites honestos

- La Standard API no documenta una acción `Heat`, por eso el conector no intenta controlar calor.
- Algunos payloads del Standard Socket API incluyen el modelo y la lista de juguetes, pero no las funciones. En ese caso se usa el catálogo.
- Un modelo nuevo queda como `unknown` hasta confirmar sus funciones y no puede recibir control.
- La entrega por socket no trae una confirmación documentada por orden. El resultado MCP significa “orden puesta en cola”, no prueba física de ejecución.

## Ventana de sesión y comportamiento

- `durationSeconds` es opcional en Preview y Live Start. Omitirlo selecciona la **default one-hour live-session window** de 3600 segundos.
- Esa hora es un sobre en el que cada pista puede repetir su partitura y cambiar mediante ajustes; no es una única orden constante.
- Las pruebas breves proporcionan una duración explícita. Ninguna sesión ni extensión puede superar 7200 segundos.
- Cada dispositivo tiene una pista explícita e independiente dentro del reloj compartido.
- Una salida no cambia en los límites de pasos idénticos. El lease de la orden cubre el resto del sobre de sesión, por lo que no depende de redispatches periódicos para continuar.
- Un cambio real reemplaza en una sola orden el estado completo de canales de la pista con `stopPrevious: 0`; un canal omitido por la nueva partitura se convierte en cero explícito. Solo una salida cero, Hold, Stop, desconexión o vencimiento debe crear una pausa.
- Una sesión de reemplazo se confirma como activa únicamente después de aceptar su primer despacho. Si ese despacho falla, la sesión anterior no se borra.
- `resumeOnReconnect` es `false` por defecto. Una desconexión provoca hold y nunca un reinicio silencioso.
- Hold envía Stop a todos los objetivos y conserva la partitura. Resume exige consentimiento nuevo y reconexión verificada.
- `lovense_stop_device` detiene y elimina solo la pista nombrada; `lovense_stop_all` detiene y limpia inmediatamente toda la sesión.
- `lovense_live_status` separa aceptación técnica (`dispatch`/`apiAcceptance`) de actividad física confirmada (`confirmedActive`, siempre `false` sin evidencia externa) y expone un registro acotado por paso con errores de despacho.

Fuentes: [Standard API](https://developer.lovense.com/docs/standard-solutions/standard-api), [Standard Socket API](https://developer.lovense.com/docs/standard-solutions/socket-api) y [catálogo oficial](https://www.lovense.com/compare?toyid=hush).
