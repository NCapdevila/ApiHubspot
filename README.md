# Api-Hubspot

API en Node.js/Express que actúa de puente entre alianzas externas (agencias productoras) y HubSpot CRM. Cada endpoint devuelve solo los campos necesarios, y cada alianza autenticada únicamente puede ver los datos de su propia agencia.

## Requisitos

- Node.js 18+
- Private App de HubSpot con scopes de lectura sobre `crm.objects.contacts`, `crm.objects.deals` y `crm.schemas.deals`

## Configuración (`.env`, no versionado)

```env
HUBSPOT_TOKEN="pat-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
PORT=3001
ALIANZAS_JSON={"<api-key>":{"name":"<nombre>","agency":"<valor de Productor/Agencia en HubSpot>","scopes":["stats","contacts"]}}
```

`ALIANZAS_JSON` mapea cada api-key a una `agency` y una lista de `scopes`. Una alianza solo puede consultar/crear datos de su propia agencia, sin importar qué mande en el request.

### Scopes

| Scope       | Habilita                                                    |
|-------------|--------------------------------------------------------------|
| `stats`     | `GET /deals/stats/by-producer-agency`                        |
| `contacts`  | `GET /deals/by-producer-agency`                               |
| `internal`  | `GET /deals/:id/status`, `GET /deals/by-contact` (uso interno) |
| `leads`     | `POST /leads`                                                 |

## Uso

```bash
npm run dev     # con --watch
npm start       # producción
```

Todos los endpoints salvo `/health` requieren header `x-api-key: <tu-api-key>`.

## Endpoints (resumen)

- `GET /health` — sin auth.
- `GET /deals/:id/status` (`internal`) — estado de un deal por ID.
- `GET /deals/by-contact?email=` (`internal`) — deals de un contacto.
- `GET /deals/stats/by-producer-agency` (`stats`) — conteo de deals por etapa, con `from`/`to`/`dateField` opcionales. Si hay sub-agencias (propiedad `agencia`), suma desglose por sub-agencia en `byAgencia`.
- `GET /deals/by-producer-agency` (`contacts`) — listado de deals con datos del contacto. Incluye `comments` cuando `stage` es `"No Interesado"`.
- `POST /leads` (`leads`) — crea/actualiza contacto + deal en etapa "Nuevo". `productor_agencia` y `lead_source` siempre salen de la api-key, nunca del body. `deal.agencia` (opcional) identifica sub-agencia sin reemplazar la agencia autenticada.

Ver `services/leadSchemas.js` para agregar un nuevo `tipoRiesgo` además de `AUTO`.

## Logs

Todas las requests quedan en `logs/access.log` (no versionado), una línea JSON por request:

```json
{"timestamp":"...","method":"POST","path":"/leads","status":201,"durationMs":842,"agency":"...","alianza":"..."}
```

`agency`/`alianza` quedan `null` si la request no pasó por auth. Filtrar: `grep '"agency":"<nombre>"' logs/access.log`.

## Seguridad

- `.env` y `logs/` en `.gitignore`, nunca se commitean.
- Cada key ligada a una sola `agency`; no se puede forzar acceso a otra vía parámetros.
- Cada key limitada a sus `scopes`; alianzas externas no reciben `internal`.