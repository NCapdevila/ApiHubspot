# API de consulta de pólizas — Cobertia Seguros

Este documento es para que el equipo técnico de **Cobertia Seguros** integre su sistema con nuestra API y consulte el estado de sus pólizas (deals) en nuestro CRM.

## Base URL

> ⚠️ **Pendiente de deploy.** Por ahora la API corre solo en ambiente local. Este documento se actualiza con la URL definitiva antes de compartirlo con Cobertia.

```
https://<A DEFINIR>
```

## Autenticación

Todos los requests deben incluir el siguiente header:

```
x-api-key: cbse_5a3fad6b6da6bc074c715692232863b2d04912869c6f24d8
```

- Esta key es de uso exclusivo de Cobertia Seguros y solo da acceso a los datos de esa agencia.
- **No debe compartirse** ni exponerse en código de frontend/cliente. Debe usarse desde su backend.
- Si se compromete, avisar para regenerarla.

## Endpoint disponible

### Estado de pólizas por etapa

```
GET /deals/stats/by-producer-agency
```

Devuelve la cantidad de pólizas (deals) de Cobertia Seguros, agrupadas por etapa de negocio, con filtro opcional de fechas.

**Parámetros (query string, todos opcionales)**

| Parámetro   | Formato               | Descripción                                              |
|-------------|------------------------|-----------------------------------------------------------|
| `from`      | `YYYY-MM-DD`           | Fecha desde (inclusive)                                   |
| `to`        | `YYYY-MM-DD`           | Fecha hasta (inclusive)                                   |
| `dateField` | `createdate`\|`closedate` | Sobre qué fecha filtrar. Default: `createdate`          |

**Ejemplo de request**

```bash
curl -H "x-api-key: cbse_5a3fad6b6da6bc074c715692232863b2d04912869c6f24d8" \
  "https://<A DEFINIR>/deals/stats/by-producer-agency?from=2026-01-01&to=2026-12-31"
```

**Ejemplo de respuesta (200 OK)**

```json
{
  "agency": "Cobertia Seguros",
  "dateField": "createdate",
  "range": { "from": "2026-01-01", "to": "2026-12-31" },
  "totalDeals": 129,
  "byStage": {
    "En proceso": 61,
    "Emitida": 0,
    "No interesado": 8
  },
  "otrasEtapas": 60
}
```

- `byStage`: cantidad de pólizas en cada una de las 3 etapas de interés.
- `otrasEtapas`: pólizas en cualquier otra etapa del proceso (nuevas, rechazadas, etc.), agrupadas aparte.

## Errores posibles

| Código | Motivo                                             |
|--------|-----------------------------------------------------|
| 400    | Parámetro `dateField` inválido                      |
| 401    | Falta el header `x-api-key` o la key es inválida     |
| 403    | La key no está autorizada para la agencia solicitada |
| 500    | Error interno consultando el CRM                    |

## Contacto

Ante cualquier duda o incidente con la integración, contactar a: `<completar con el mail/canal de soporte>`.
