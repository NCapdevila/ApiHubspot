# Api-Hubspot

API en Node.js/Express que actúa de puente entre alianzas externas (agencias productoras) y HubSpot CRM. Cada endpoint devuelve solo los campos necesarios, y cada alianza autenticada únicamente puede ver los datos de su propia agencia.

## Requisitos

- Node.js 18+
- Private App de HubSpot con scopes de lectura sobre `crm.objects.contacts`, `crm.objects.companies`, `crm.objects.deals` y `crm.schemas.deals`

### Propiedades custom requeridas en HubSpot

Los clientes empresa se modelan como objetos **Company**, por lo que el objeto Companies necesita dos propiedades custom ya creadas:

| Propiedad          | Label / internal name              | Para qué                                                                 |
|--------------------|------------------------------------|--------------------------------------------------------------------------|
| Productor/Agencia  | label `Productor/Agencia`          | Mismo label que la propiedad de Contacts. El internal name se resuelve por label, no hace falta que coincida con el de Contacts. |
| Email              | internal name `email`              | Company no trae email por defecto. Se escribe al crear el lead y se lee en los listados. |

Si falta cualquiera de las dos, los endpoints por agencia y el alta de leads empresa fallan con error explícito.

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
npm test        # tests de leads/listados con el cliente de HubSpot mockeado (sin red)
```

Todos los endpoints salvo `/health` requieren header `x-api-key: <tu-api-key>`.

## Endpoints (resumen)

- `GET /health` — sin auth.
- `GET /deals/:id/status` (`internal`) — estado de un deal por ID.
- `GET /deals/by-contact?email=` (`internal`) — deals de un contacto.
- `GET /deals/stats/by-producer-agency` (`stats`) — conteo de deals por etapa, con `from`/`to`/`dateField` opcionales. Si hay sub-agencias (propiedad `agencia`), suma desglose por sub-agencia en `byAgencia`.
- `GET /deals/by-producer-agency` (`contacts`) — listado de deals con datos del cliente. Cada registro trae `type`: `"person"` (con `firstName`/`lastName`) o `"company"` (con `companyName`). Incluye `comments` cuando `stage` es `"No Interesado"`.
- `POST /leads` (`leads`) — crea/actualiza cliente + deal en etapa "Nuevo". `productor_agencia` y `lead_source` siempre salen de la api-key, nunca del body. `deal.agencia` (opcional) identifica sub-agencia sin reemplazar la agencia autenticada.

Ver `services/leadSchemas.js` para agregar un nuevo `tipoRiesgo` además de `AUTO`.

### Clientes persona vs. clientes empresa en `POST /leads`

`contact.email` y `contact.phone` son siempre obligatorios. El resto depende del tipo de cliente:

| Campo                | Persona       | Empresa                     |
|----------------------|---------------|-----------------------------|
| `contact.firstName`  | obligatorio   | no aplica                   |
| `contact.lastName`   | obligatorio   | no aplica                   |
| `contact.companyName`| no se manda   | obligatorio (string no vacío) |
| `contact.dateOfBirth`| opcional      | no aplica (se ignora)       |
| `contact.whatsappPhone`| opcional    | no aplica (se ignora)       |

`contact.companyName` es la **alternativa** a `firstName` + `lastName`: si viene, el cliente se crea como **Company** en HubSpot en vez de como Contact, y `firstName`/`lastName` dejan de ser obligatorios. `country`, `state`, `city` y `zip` se mapean igual en ambos casos. `whatsappPhone` y `dateOfBirth` sólo aplican a personas: el objeto Company no tiene esas propiedades.

La empresa se busca por nombre exacto **dentro de la agencia** (`name` + `Productor/Agencia`): si existe se actualiza, si no se crea. El deal se asocia a la Company con la asociación default. La respuesta devuelve `company` en vez de `contact`:

```json
{
  "company": { "id": "123", "name": "Transportes SRL", "email": "contacto@transportes.com" },
  "deal": { "id": "456", "name": "...", "stage": "Nuevo", "pipeline": "..." }
}
```

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