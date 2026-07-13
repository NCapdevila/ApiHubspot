# Api-Hubspot

API en Node.js/Express que actúa de puente entre alianzas externas (agencias productoras) y HubSpot CRM. Nunca expone objetos crudos de HubSpot: cada endpoint devuelve solo los campos necesarios, y cada alianza autenticada únicamente puede ver los datos de su propia agencia.

## Requisitos

- Node.js 18+
- Una Private App de HubSpot con scopes de lectura sobre `crm.objects.contacts`, `crm.objects.deals` y `crm.schemas.deals` (pipelines)

## Instalación

```bash
npm install
```

## Configuración

Crear un archivo `.env` en la raíz con:

```env
HUBSPOT_TOKEN="pat-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
PORT=3001
ALIANZAS_JSON={"<api-key>":{"name":"<nombre>","agency":"<valor exacto de Productor/Agencia en HubSpot>","scopes":["stats","contacts"]}}
```

- **HUBSPOT_TOKEN**: token de la Private App de HubSpot.
- **PORT**: puerto donde levanta el server (default `3001`).
- **ALIANZAS_JSON**: mapa de API keys válidas. Cada key está atada a una `agency` (el valor exacto de la propiedad de contacto **Productor/Agencia** en HubSpot) y a una lista de `scopes` que determina a qué endpoints puede acceder. Una alianza solo puede consultar los datos de la agencia que tiene asignada, sin importar qué mande en el request.

### Scopes disponibles

| Scope       | Habilita                                 |
|-------------|--------------------------------------------|
| `stats`     | `GET /deals/stats/by-producer-agency`       |
| `contacts`  | `GET /deals/by-producer-agency`             |
| `internal`  | `GET /deals/:id/status`, `GET /deals/by-contact` (uso interno, no se otorga a alianzas externas) |

Una key sin el scope correspondiente recibe `403` al intentar usar ese endpoint.

### Dar de alta una nueva alianza

1. Generar una key aleatoria:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
2. Agregar una entrada en `ALIANZAS_JSON` con esa key, la `agency` correspondiente y los `scopes` que va a tener (normalmente `["stats", "contacts"]` para una alianza externa).
3. Reiniciar el server (no requiere tocar código).

## Uso

```bash
npm start       # producción
npm run dev     # con --watch
```

Todos los endpoints (salvo `/health`) requieren el header:

```
x-api-key: <tu-api-key>
```

## Endpoints

### `GET /health`

Chequeo de vida del servicio. No requiere autenticación.

### `GET /deals/:id/status` (scope `internal`)

Estado de un deal puntual por su ID de HubSpot.

**Respuesta**
```json
{
  "id": "12345",
  "name": "Poliza Auto - Juan Perez",
  "stage": "1333717762",
  "amount": "1500",
  "pipeline": "886201234",
  "closeDate": null,
  "createdDate": "2026-07-01T12:00:00.000Z"
}
```

### `GET /deals/by-contact?email=xxx` (scope `internal`)

Deals asociados a un contacto, buscado por email.

**Respuesta**
```json
{
  "contact": { "id": "1", "email": "juan@mail.com", "firstName": "Juan", "lastName": "Perez", "phone": null },
  "deals": [ { "id": "12345", "name": "...", "stage": "...", "amount": "...", "pipeline": "...", "closeDate": null, "createdDate": "..." } ]
}
```

### `GET /deals/stats/by-producer-agency` (scope `stats`)

Cantidad de deals de la agencia asociada a la API key usada, agrupados por etapa de negocio ("En proceso", "Emitida", "No interesado"), con filtro opcional de fechas.

**Query params**
| Param       | Requerido | Descripción                                                        |
|-------------|-----------|---------------------------------------------------------------------|
| `from`      | No        | Fecha inicio (`YYYY-MM-DD`), inclusive                              |
| `to`        | No        | Fecha fin (`YYYY-MM-DD`), inclusive (incluye todo ese día)          |
| `dateField` | No        | `createdate` (default) o `closedate`                                |

**Ejemplo**
```bash
curl -H "x-api-key: <tu-api-key>" \
  "http://localhost:3001/deals/stats/by-producer-agency?from=2026-01-01&to=2026-12-31"
```

**Respuesta**
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

`otrasEtapas` cuenta los deals de la agencia que están en cualquier otra etapa del pipeline (ej. "Nuevo", "Error", "Duplicado", "Vendida", "Baja").

### `GET /deals/by-producer-agency` (scope `contacts`)

Listado (no agregado) de los deals de la agencia asociada a la API key, con los datos del contacto asociado a cada uno y su etapa. Mismos query params que el endpoint de stats (`from`, `to`, `dateField`). Si la etapa es **"No Interesado"**, cada registro incluye además el comentario cargado en el deal (propiedad `comentarios` de HubSpot).

**Ejemplo**
```bash
curl -H "x-api-key: <tu-api-key>" \
  "http://localhost:3001/deals/by-producer-agency?from=2026-01-01&to=2026-12-31"
```

**Respuesta**
```json
{
  "agency": "Cobertia Seguros",
  "dateField": "createdate",
  "range": { "from": "2026-01-01", "to": "2026-12-31" },
  "total": 2,
  "deals": [
    {
      "dealId": "62439844427",
      "firstName": "Julio",
      "lastName": null,
      "phone": "+5491140874644",
      "email": "julio@mail.com",
      "stage": "No Interesado",
      "comments": "no quiere"
    },
    {
      "dealId": "62427738795",
      "firstName": "Ernesto",
      "lastName": null,
      "phone": "+5491146976908",
      "email": "ernesto@mail.com",
      "stage": "Duplicado"
    }
  ]
}
```

El campo `comments` solo aparece cuando `stage` es `"No Interesado"`; en el resto de las etapas no se incluye.

## Notas de seguridad

- `.env` está en `.gitignore` y nunca debe commitearse.
- Las API keys de alianzas viven en `ALIANZAS_JSON`, no en el código fuente.
- Cada key está ligada a una sola `agency`: no se puede consultar datos de otra agencia aunque se fuerce el parámetro en la URL.
- Cada key solo puede usar los endpoints habilitados por sus `scopes`. Las alianzas externas no reciben el scope `internal`.
