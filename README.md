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
- `POST /leads/with-attachment` (`leads`) — igual que `POST /leads` pero con un archivo adjunto. Ver más abajo.
- `POST /leads` (`leads`) — crea/actualiza cliente + deal en etapa "Nuevo". `productor_agencia` y `lead_source` siempre salen de la api-key, nunca del body. `deal.agencia` (opcional) identifica sub-agencia sin reemplazar la agencia autenticada.

Ver `services/leadSchemas.js` para agregar un nuevo `tipoRiesgo` además de `AUTO` y `HOGAR`.

### Tipos de riesgo

**`AUTO`** — `deal.details`: `marca`, `modelo`, `version`, `anio`, `numeroMotor`, `numeroChasis`, `es0km` (obligatorios); `patente`, `esPrendado` (opcionales).

**`MOVILIDAD`** (Seguros movilidad) — `deal.details`: ninguno obligatorio. `amount` y `comentarios` opcionales. Los datos del lead (nombre, apellido, teléfono, mail, código postal) van todos en `contact`. La factura de compra se manda como adjunto, por `POST /leads/with-attachment`.

**`HOGAR`** — `deal.details`: `tipoHogar`, `ambientes` (obligatorios); `amount`, `comentarios` (opcionales). Acepta además los nombres internos de HubSpot como alias (`tipo_hogar`, `ambientes_hogar`, `comments`), porque el form de esa alianza los manda así.

`amount` va a la propiedad numérica `amount` de HubSpot. Se acepta número o string, con `$`/espacios, pero **se rechaza todo formato ambiguo**: `"150.000"` puede ser 150000 o 150, así que devuelve 400 en vez de arriesgar un monto mal cargado. Formatos válidos: `150000`, `"150000"`, `"150000.50"`, `"$150000"`.

### `POST /leads/with-attachment` — lead con archivo adjunto

Mismo lead que `POST /leads`, más un archivo. Se manda como **`multipart/form-data`** con dos campos:

| Campo | Qué va |
|---|---|
| `payload` | el **mismo JSON** que recibe `POST /leads`, como string |
| `archivo` | el archivo: PDF, JPG, PNG o WEBP, hasta **10 MB** |

```bash
curl -X POST https://api.cebrokers.com.ar/hubspot/leads/with-attachment \
  -H "x-api-key: <key>" \
  -F 'payload={"contact":{"firstName":"Juan Carlos","lastName":"Perez Garcia","email":"jc@example.com","phone":"+5491155550010","zip":"1425"},"deal":{"tipoRiesgo":"MOVILIDAD"}}' \
  -F "archivo=@factura.pdf"
```

**Qué hace con el archivo**, en este orden:

1. Lo sube a la biblioteca de Files de HubSpot, en `/alianzas-adjuntos`, con acceso `PRIVATE` (no queda accesible por URL pública).
2. Crea el lead (contacto/empresa + deal), igual que `POST /leads`.
3. Crea una **nota** con el archivo adjunto (`hs_attachment_ids`) y la asocia al deal, y al contacto o la empresa.

Ese paso 3 es lo que hace que el archivo aparezca en la tarjeta **"Archivos adjuntos"** del registro en HubSpot: esa tarjeta muestra los adjuntos de las actividades, no un campo del deal.

El archivo se sube **antes** de tocar el CRM a propósito: si falla (tamaño, tipo, permisos) no queda un lead creado sin su factura. El archivo se procesa en memoria, nunca se escribe al disco del server.

La respuesta es la de `POST /leads` más un bloque `attachment`:

```json
{
  "contact": { "id": "...", "email": "...", "firstName": "...", "lastName": "..." },
  "deal": { "id": "...", "name": "...", "stage": "Nuevo", "pipeline": "..." },
  "attachment": { "fileId": "...", "name": "factura", "url": "https://...", "noteId": "..." }
}
```

Requiere el scope **`files`** (escritura) en la Private App de HubSpot.

`deal.notaAdjunto` (opcional) cambia el texto de la nota; por default dice `Archivo adjuntado por la alianza <agencia>.`

### Etapa del deal

Hay tres formas de fijar la etapa, en este orden de prioridad:

| Campo | Pipeline | Etapa |
|---|---|---|
| `deal.dealstage` (ID) | derivado del ID de la etapa | la que corresponda al ID |
| `deal.emitida: true` | `CE BROKERS - CLIENTES` (`907998512`) | `Cliente` (`1377519216`) |
| nada | `CE BROKERS - VENTAS` (resuelto por label) | `Nuevo` |

**`deal.dealstage`** (opcional) toma el **ID** de la etapa en HubSpot, no el nombre: `"1333717765"`. Acepta string o número. **El pipeline no se manda**: se deriva del ID, porque HubSpot exige que el `dealstage` pertenezca al `pipeline` enviado y un mismo label puede existir en varios pipelines (`Cliente` está en los dos).

Si el ID no existe en ningún pipeline, la respuesta es **400** con el ID en el mensaje (no un 500). Antes de rechazar se refresca la caché de pipelines una vez, así una etapa recién creada en HubSpot funciona sin esperar el TTL de 1h.

Mandar `dealstage` y `emitida: true` juntos da **400**: las dos cosas fijan la etapa, mandar ambas es contradictorio.

El caso `emitida` es el único lugar del código que usa IDs de pipeline/etapa en vez de resolver por label: la etapa `Cliente` existe con ese mismo nombre en los dos pipelines, así que el label es ambiguo y el ID no. Están como constantes en `services/hubspotServices.js`. Al arrancar se valida contra los pipelines reales que la etapa exista y pertenezca a ese pipeline; si no, falla con un error explícito.

### Clientes persona vs. clientes empresa en `POST /leads`

`contact.email` y `contact.phone` son siempre obligatorios. El resto depende del tipo de cliente:

| Campo                | Persona       | Empresa                     |
|----------------------|---------------|-----------------------------|
| `contact.firstName`  | obligatorio   | no aplica                   |
| `contact.lastName`   | obligatorio   | no aplica                   |
| `contact.companyName`| no se manda   | obligatorio (string no vacío) |
| `contact.dateOfBirth`| opcional      | no aplica (se ignora)       |
| `contact.whatsappPhone`| opcional    | no aplica (se ignora)       |
| `contact.dni`        | opcional      | no aplica (se ignora)       |

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