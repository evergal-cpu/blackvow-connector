# Capacidades de dispositivos

## Fuente de verdad

El conector decide las capacidades en este orden:

1. `fullFunctionNames` o `shortFunctionNames` anunciados por el dispositivo.
2. Catálogo conservador por `toyType`/nombre.
3. Estado `unknown`: la interfaz lo muestra, pero BLACKVOW rechaza el control hasta recibir capacidades reales; nunca prueba una función sobre el cuerpo para descubrirla.

Esto evita asumir que todos los Lovense vibran o que dos revisiones de hardware son idénticas.

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
- La página oficial del producto atribuye calentamiento al accesorio recto, pero la Standard API no documenta una acción `Heat`; por eso BLACKVOW no la fabrica ni la imita.
- Turbo se mantiene fuera de la superficie hasta que exista una acción pública documentada que se pueda validar y detener de forma independiente.
- Cada canal usa 100% de techo por defecto. Un techo configurado menor escala 0–20 dentro de ese porcentaje; nunca aumenta por encima de la salida permitida por Lovense Remote.

## Límites honestos

- La Standard API no documenta una acción `Heat`, por eso el conector no intenta controlar calor.
- Algunos payloads del Standard Socket API incluyen el modelo y la lista de juguetes, pero no las funciones. En ese caso se usa el catálogo.
- Un modelo nuevo queda como `unknown` hasta confirmar sus funciones y no puede recibir control.
- La entrega por socket no trae una confirmación documentada por orden. El resultado MCP significa “orden puesta en cola”, no prueba física de ejecución.

Fuentes: [Standard API](https://developer.lovense.com/docs/standard-solutions/standard-api), [Standard Socket API](https://developer.lovense.com/docs/standard-solutions/socket-api) y [catálogo oficial](https://www.lovense.com/compare?toyid=hush).
