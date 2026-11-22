# Finanzas personales (Fase 0)

App web instalable (PWA) que guarda tus datos en el dispositivo y los sincroniza entre PC y celular mediante **un archivo cifrado en un repositorio privado de GitHub**. No hay servidor propio ni nada encendido 24/7.

## Probar en tu PC antes de publicar

**No abras `index.html` con doble clic**: el navegador bloquea los módulos y el cifrado en `file://` y no funciona nada. En su lugar, dentro de la carpeta:

```
python3 -m http.server 8000
```

(en Windows puede ser `python -m http.server 8000`) y abre `http://localhost:8000`. Para usarla en el celular necesitas publicarla en GitHub Pages (pasos abajo), porque `localhost` solo existe en tu PC.

## Cómo funciona la privacidad

- El código de la app va en un repositorio **público** (para GitHub Pages). No contiene datos.
- Tus datos van en un repositorio **privado** distinto, en un solo archivo (`datos.enc.json`) cifrado en tu dispositivo con AES-GCM. La contraseña nunca se sube.
- Si pierdes la contraseña, los datos no se pueden recuperar. Guárdala en tu gestor de contraseñas.

## Puesta en marcha

### 1. Crear los dos repositorios en GitHub

| Repositorio | Visibilidad | Contenido |
|---|---|---|
| `finanzas-app` | Público | Los archivos de este zip |
| `finanzas-datos` | **Privado** | Solo un README inicial (márcalo al crearlo: "Add a README file") |

### 2. Publicar la app

1. En `finanzas-app`: **Add file → Upload files** y arrastra todos los archivos del zip (sin la carpeta contenedora; `test-sync.mjs` es opcional).
2. **Settings → Pages → Build and deployment**: Source "Deploy from a branch", rama `main`, carpeta `/ (root)`.
3. Espera uno o dos minutos. La app queda en `https://TU-USUARIO.github.io/finanzas-app/`.

### 3. Crear el token de acceso

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access → Only select repositories** → elige solo `finanzas-datos`.
3. **Permissions → Repository permissions → Contents: Read and write**.
4. Elige una fecha de vencimiento y copia el token (solo se muestra una vez). Anota cuándo vence: ese día habrá que crear otro.

### 4. Configurar el primer dispositivo (PC)

1. Abre la URL de la app → pestaña **Ajustes**.
2. Usuario de GitHub, repositorio `finanzas-datos`, token. Rama y archivo se pueden dejar con sus valores por defecto.
3. **Guardar y sincronizar** → te pedirá crear la contraseña de cifrado.

### 5. Configurar el celular

1. Abre la misma URL y complétala igual: mismo usuario, repositorio y token, y **la misma contraseña**.
2. Instálala:
   - **Android (Chrome):** menú ⋮ → "Instalar app" o "Añadir a pantalla de inicio".
   - **iPhone (Safari):** botón Compartir → "Añadir a pantalla de inicio".

> Importante en iPhone: la app instalada y Safari guardan los datos por separado. Configura y usa siempre la misma (la instalada).

### 6. Probar

Crea una nota en la pestaña **Pruebas** en el PC, toca **Sincronizar**, y en el celular toca **Sincronizar**: debe aparecer. Prueba también marcarla como hecha y borrarla desde el otro lado.

## Cómo se sincroniza

- Al abrir la app, unos segundos después de cada cambio, al recuperar internet, y cuando pulsas **Sincronizar**.
- Cada registro tiene id, fecha de modificación y dispositivo. Al mezclar gana la modificación más reciente de cada registro; los borrados se propagan.
- Como se usan las horas de cada dispositivo, conviene tener la hora automática activada.
- Todo funciona sin internet; los cambios se envían cuando vuelvas a conectarte.

## Respaldo manual

En Ajustes: **Exportar respaldo** descarga un archivo cifrado; **Importar respaldo** lo mezcla con lo que ya tienes. Haz uno de vez en cuando.

## Actualizar la app

Sube los archivos nuevos al repositorio `finanzas-app`. La versión nueva se ve al abrir la app por segunda vez (la primera carga sirve la copia guardada y actualiza por detrás).

## Qué incluye la Fase 1

- **Resumen:** neto, disponible y deuda de tarjetas por moneda (COP y USD por separado), ingresos y gastos del mes, y la lista de cuentas.
- **Cuentas:** débito/ahorros, billetera virtual, efectivo, tarjeta de crédito e inversión, cada una en COP o USD. En las tarjetas pones la *deuda actual* y, si quieres, el *cupo*, y la app te muestra cuánto debes y cuánto te queda disponible.
- **Movimientos:** botón **＋** para registrar gasto, ingreso o transferencia. Las transferencias entre monedas piden también el monto que recibe la cuenta destino (por ejemplo, pesos que pasas a Hapi y los dólares que llegan). Pagar una tarjeta es una transferencia hacia ella.
- **Saldos calculados:** el saldo de cada cuenta es saldo inicial + movimientos; nunca se guarda un saldo, así que dos dispositivos no se pisan.
- **Totales del mes** sin contar transferencias (pagar la tarjeta no es un gasto nuevo: el gasto ya se registró al comprar).
- **Categorías** editables en Ajustes; las archivadas dejan de ofrecerse pero conservan sus movimientos viejos.
- Las "notas de prueba" de la Fase 0 ya no se muestran.

La primera vez, en **Resumen**, el botón *Crear cuentas sugeridas* crea Nequi, Nubank (débito y crédito), Rappi (débito y crédito) y Hapi con saldo en cero; toca cada una para poner su saldo.

## Pruebas

- `node test-sync.mjs` (Node 18+): dos dispositivos y un GitHub falso (cifrado, contraseña incorrecta, ediciones, borrados, conflictos y respaldo).
- `node test-ledger.mjs`: lectura de montos (`12.500`, `1,234.56`…), saldos, totales del mes, filtros y resumen.
