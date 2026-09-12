# Security policy

Este proyecto controla hardware íntimo. Los cambios de seguridad deben revisarse con el criterio **fail closed**: ante duda, bloquear control y conservar la parada.

## Modelo de amenazas

Se protege frente a:

- una persona que descubre el endpoint público;
- robo o falsificación de callbacks/clientes OAuth;
- una IA que intenta usar una función no soportada o superar límites;
- reintentos MCP duplicados;
- pérdida del volumen o reinicio del servidor;
- filtración del archivo de estado.

## Controles

- Un despliegue aislado por dueña.
- OAuth 2.1 authorization-code + PKCE S256 para `/mcp`.
- Registro dinámico limitado a callbacks HTTPS de ChatGPT.
- Tokens firmados con audiencia, alcance y expiración; códigos de un solo uso.
- Owner Key necesaria para autorizar ChatGPT y abrir el panel.
- Tres secretos independientes adicionales para OAuth, estado y ruta MCP alternativa.
- Solo se envían órdenes a dispositivos que Lovense Remote informa como conectados.
- Cada orden valida funciones y rangos contra las capacidades del juguete.
- `lovense_hold`, `lovense_stop_device` y `lovense_stop_all` separan pausa, parada selectiva y RED global.
- Estado cifrado AES-256-GCM; permisos de archivo `0600` cuando el sistema lo permite.
- Ningún token se incluye en JavaScript, respuestas públicas ni logs de aplicación.
- CSP, bloqueo de framing, `no-store`, protección de Host y límites de tamaño JSON/form.

## Riesgos residuales

- Railway y Lovense siguen siendo terceros de confianza para transporte y alojamiento.
- El endpoint de ruta secreta es compatibilidad para clientes sin OAuth; quien obtenga esa URL puede invocar MCP cuando el dispositivo esté conectado. No debe usarse para una publicación de directorio.
- Un dispositivo físico puede seguir ejecutando una orden breve si se pierde la red antes de que llegue `Stop`; por eso las órdenes tienen duración máxima.
- Los tokens OAuth de acceso duran una hora y los refresh tokens 30 días. Rotar `OAUTH_SIGNING_KEY` revoca todos.

## Reglas para contribuciones

- Nunca guardar tokens reales, IDs de juguetes, dominios privados ni capturas con QR.
- No aumentar límites predeterminados ni permitir control indefinido sin una decisión explícita de producto.
- Toda función mutante nueva necesita validación de dispositivo, capacidades y pruebas negativas.
- La parada debe seguir disponible aunque falle cualquier otra validación.
- Ejecutar `npm run check`, `npm test`, `npm run build` y `npm audit --omit=dev` antes de publicar.

Para reportar una vulnerabilidad, contacta de forma privada con la mantenedora del repositorio. No abras un issue público con secretos o instrucciones de explotación.
