# Finanzas personales

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

## Actualizar la app (con git)

En vez de subir archivos uno por uno en la web de GitHub, publica con **git**: se sube todo de una vez, no se queda ningún archivo atrás y cada versión queda en el historial (si algo falla, puedes volver a la anterior).

### Primera vez

**En Linux (CachyOS/Arch) o Windows, con la terminal:**

1. Instala git: `sudo pacman -S git` (CachyOS) o `winget install Git.Git` (Windows).
2. Dile quién eres (una sola vez):
   ```
   git config --global user.name "Tu nombre"
   git config --global user.email "tu-correo@ejemplo.com"
   ```
3. Descarga tu repositorio de la app a una carpeta:
   - Si ya tienes una llave SSH en GitHub: `git clone git@github.com:TU-USUARIO/finanzas-app.git`
   - Si no: instala la herramienta `gh` (`sudo pacman -S github-cli` o `winget install GitHub.cli`), corre `gh auth login` y luego `gh repo clone TU-USUARIO/finanzas-app`.

**En Windows o Mac, sin terminal:** instala [GitHub Desktop](https://desktop.github.com), inicia sesión y usa **File → Clone repository → finanzas-app**.

### Cada vez que te mande una versión nueva

1. Descomprime el zip **encima** de la carpeta `finanzas-app` (reemplaza los archivos; no borres la carpeta oculta `.git`).
2. Terminal:
   ```
   cd finanzas-app
   git add -A
   git commit -m "Fase 5"
   git push
   ```
   GitHub Desktop: escribe un resumen abajo a la izquierda → **Commit to main** → **Push origin**.
3. En uno o dos minutos GitHub Pages publica la versión nueva. Ábrela con internet en cada dispositivo.

Para volver a una versión anterior de la app: `git revert HEAD` y `git push` (o, en GitHub Desktop, clic derecho sobre el último commit → *Revert changes in commit*).

> **No clones el repositorio de datos (`finanzas-datos`)**: lo maneja la app y su historial se limpia solo; una copia local quedaría desfasada.

## Qué incluye la Fase 1

- **Resumen:** neto, disponible y deuda de tarjetas por moneda (COP y USD por separado), ingresos y gastos del mes, y la lista de cuentas.
- **Cuentas:** débito/ahorros, billetera virtual, efectivo, tarjeta de crédito e inversión, cada una en COP o USD. En las tarjetas pones la *deuda actual* y, si quieres, el *cupo*, y la app te muestra cuánto debes y cuánto te queda disponible.
- **Movimientos:** botón **＋** para registrar gasto, ingreso o transferencia. Las transferencias entre monedas piden también el monto que recibe la cuenta destino (por ejemplo, pesos que pasas a Hapi y los dólares que llegan). Pagar una tarjeta es una transferencia hacia ella.
- **Saldos calculados:** el saldo de cada cuenta es saldo inicial + movimientos; nunca se guarda un saldo, así que dos dispositivos no se pisan.
- **Totales del mes** sin contar transferencias (pagar la tarjeta no es un gasto nuevo: el gasto ya se registró al comprar).
- **Categorías** editables en Ajustes; las archivadas dejan de ofrecerse pero conservan sus movimientos viejos.
- Las "notas de prueba" de la Fase 0 ya no se muestran.

La primera vez, en **Resumen**, el botón *Crear cuentas sugeridas* crea Nequi, Nubank (débito y crédito), Rappi (débito y crédito) y Hapi con saldo en cero; toca cada una para poner su saldo.

## Qué incluye la Fase 2: deudas

Pestaña **Deudas** para lo que te deben (*Me deben*) y lo que debes a personas o entidades (*Debo*). Las tarjetas de crédito siguen en Cuentas.

- **Cada deuda** tiene persona o entidad, moneda, monto, fecha, vencimiento opcional y nota.
- **Abonos parciales:** tocas la deuda y registras abonos (o pagos, si es una deuda tuya) hasta saldarla. No deja abonar más de lo que falta.
- **Cuenta opcional:** si al crear la deuda o al abonar eliges una cuenta, el saldo de esa cuenta se mueve (te prestan: entra; prestas: sale; te pagan: entra; pagas: sale). Si no eliges cuenta, solo se lleva el registro de la deuda.
- **Marcar saldada** cierra una deuda a mano (por ejemplo si te la perdonan); queda en "Saldadas" y se puede reabrir.
- **Resumen:** el neto de cada moneda incluye lo que te deben y lo que debes, y aparece una sección **Vencimientos** con las deudas vencidas o que vencen en los próximos 7 días.
- **Movimientos** también lista los préstamos y abonos que tocan una cuenta, para que cada cambio de saldo tenga explicación. No cuentan como ingreso ni gasto del mes.
- Al **eliminar una deuda** se borran sus abonos y se revierte su efecto en las cuentas.

### Deudas por persona

Arriba de las listas, la sección **Por persona** muestra una tarjeta por cada persona con lo que queda pendiente: *Te debe* o *Le debes* (el neto, por moneda). Si con la misma persona hay deudas en los dos sentidos, también ves el detalle. Los nombres iguales se agrupan sin importar mayúsculas, tildes o espacios ("Juan", " juan "). Las deudas saldadas no cuentan. Toca una tarjeta para ver solo las deudas de esa persona y vuelve a tocarla (o *Quitar filtro*) para ver todas.

### Corte y pago de tarjetas

En una tarjeta de crédito (editar cuenta) puedes poner el **día de corte** y el **día límite de pago**. Con eso:

- La fila de la tarjeta muestra el próximo pago y cuánto toca pagar, y la fecha del próximo corte.
- Si el corte de ese pago ya ocurrió, el monto es la deuda que había al corte menos lo que has abonado desde entonces. Las compras posteriores al corte van al siguiente extracto.
- Si el corte aún no ocurre, el monto es un estimado ("aprox."): lo que debes hasta hoy, que puede crecer hasta el corte.
- Si el pago vence en los próximos 7 días, aparece en **Vencimientos** del Resumen. Al tocarlo se abre una transferencia hacia la tarjeta con el monto ya puesto; eliges desde qué cuenta pagas.

## Qué incluye la Fase 3: reportes y presupuesto

Pestaña **Reportes**. Arriba, una sola fila de filtros (mes y moneda) que controla todo lo de abajo:

- **Ingresos, gastos y balance** del mes, con la variación contra el mes anterior (▲/▼ en verde o rojo según si subir es bueno o malo).
- **Gastos por categoría:** barras ordenadas de mayor a menor, con el monto en la punta y el porcentaje. Si hay más de 8 categorías, las más pequeñas se agrupan en "Otras".
- **Presupuesto del mes:** defines un tope mensual por categoría (y por moneda) y ves cuánto llevas. Estados: ✓ holgado, ⚠ cerca del límite (desde el 80%) y ✕ excedido. El monto del presupuesto es el mismo cada mes.
- **Ingresos y gastos** de los últimos 6 meses en columnas.
- **Patrimonio neto** al cierre de cada mes: cuentas + lo que te deben − tarjetas y deudas. Se va llenando con el tiempo: al principio solo verás desde tu primer dato hasta hoy.

Pasa el dedo o el cursor por un gráfico para ver el detalle, y cada gráfico tiene "Ver como tabla" con los mismos datos. Las transferencias, los pagos de tarjeta y los préstamos no cuentan como ingreso ni gasto. Los presupuestos se sincronizan como el resto de tus datos.

## Meta de ahorro (cajita)

Para seguir cuánto ahorras cada mes en tu cajita de Nu:

1. Crea una cuenta de tipo **Ahorro / cajita** (por ejemplo "Nubank cajita"). En **Resumen**, el botón *Definir meta de ahorro* te lleva a crearla si aún no existe.
2. Define la **meta mensual** y, si quieres, la **anual** (si la dejas vacía, será 12 veces la mensual; si solo pones la anual, la mensual es la anual entre 12).
3. Cuando metas plata a la cajita, usa **＋ Aportar** en la tarjeta de ahorro (abre una transferencia hacia la cajita) o registra una transferencia normal.

Cómo se cuenta:
- **Aporte del mes** = lo que entra a la cajita por transferencia, menos lo que sacas de ella (retiros y gastos pagados desde ella).
- Los **rendimientos** (intereses) los registras como *ingreso* en la cajita; se muestran aparte y no cuentan como aporte tuyo, pero sí suben el saldo.
- La tarjeta del Resumen muestra el avance del mes y del año. Para la meta anual te dice cuánto necesitas ahorrar **al mes, de aquí a diciembre**, para llegar (⚠ si es más que tu meta mensual, ✓ si vas bien).
- En **Reportes** hay un gráfico con los aportes de cada mes del año y la línea de la meta.

Si empiezas a ahorrar a mitad de año, pon una meta anual acorde a los meses que quedan; si no, la app te avisará con ⚠ que no alcanzas con tu meta mensual.

## Fase 4: inversiones

Pestaña **Inversiones** para acciones y ETF (VOO, VXUS, NVDA, META, NU…). **Ajustes** pasó al botón ⚙ del encabezado.

- **Operaciones:** compra, venta y dividendo (＋). La cantidad admite fracciones (`0,0153`). El total se calcula con cantidad × precio (+/− comisión); si tu bróker te da otro total exacto, escríbelo y se usa ese.
- **Lo que ya tienes:** regístralo como una compra con fecha aproximada y deja la cuenta en *No afecta ninguna cuenta*. Si eliges una cuenta (por ejemplo Hapi), la compra resta de su saldo y la venta o el dividendo suman.
- **Costo promedio:** al vender se retira del costo la parte proporcional; la diferencia es la *ganancia realizada*. La *ganancia sin vender* es valor actual − costo. Dividendos aparte.
- **Ojo con no contar doble:** el saldo de una cuenta de inversión (Hapi) debe ser solo el efectivo; las acciones se cuentan aquí. En el **Resumen** el neto en USD suma las inversiones a su valor actual. En el gráfico de patrimonio de Reportes se suman **a costo** (no hay precios históricos).
- **Precios:** a mano (toca la posición → *Precio actual*) o automáticos con una clave gratis de [Twelve Data](https://twelvedata.com) (Ajustes → Precios de inversiones). La clave se guarda solo en el dispositivo. El plan gratis permite 8 consultas por minuto; la app pide todos los símbolos en una sola y consulta al entrar a la pestaña (máx. cada 10 min) o con *Actualizar precios*. Si falla (sin clave, límite, sin conexión o el navegador bloquea la consulta) se avisa y queda el último precio. Sin precio, la posición se valora a costo.
- Los precios y operaciones se sincronizan cifrados como lo demás.

### Dólar, ganancia en pesos e inflación

Para saber si de verdad ganas, la app también calcula en pesos (solo posiciones en USD):

- **Dólar de cada compra:** al registrar una compra en USD, el campo *Dólar ese día (TRM)* se llena solo con la TRM oficial de esa fecha (datos abiertos de la Superfinanciera, sin clave). Puedes corregirla a mano. Si no se pudo traer, usa **Buscar TRM faltantes** en la pestaña para completar las compras que no la tienen.
- **Dólar de hoy:** se trae al entrar a Inversiones (o con *Actualizar precios*); toca la tarjeta *Dólar e inflación* para escribirlo a mano.
- **Ganancia en pesos** = valor de hoy en pesos − lo que pagaste en pesos (cada compra al dólar de su día). Así ves el efecto del dólar: puedes ganar en dólares y perder en pesos, o al revés.
- **Ganancia real:** descuenta la inflación. Defines **una tasa anual** (la del IPC que publica el DANE) y la app la aplica a cada compra por los días que lleva. Es una aproximación: no usa el IPC mes a mes. Si pones la inflación en 0, real = nominal.
- La *ganancia realizada* (ventas) sigue en dólares.
- Los lotes se reducen en proporción al vender, igual que el costo promedio.

## Metas de ahorro con nombre

Al crear o editar una meta puedes ponerle un nombre (ej. "Fondo de emergencia"); si lo dejas vacío se usa el de la cuenta.

## Eliminar cuentas y personalizar la vista

- **Eliminar cuenta:** toca la cuenta → **Eliminar cuenta**. Si tiene movimientos, la app te dice cuántos y los elimina junto con la cuenta (incluidas las transferencias que la tocan); no se puede deshacer. Las deudas, abonos y operaciones de inversión que usaban esa cuenta se conservan, pero sin cuenta asociada. Si solo quieres ocultarla, usa *Archivada*.
- **Ajustes → Vista** (se guarda en cada dispositivo, no se sincroniza): quitar las pestañas Movimientos, Inversiones, Deudas o Reportes; ocultar *Meta de ahorro* y *Vencimientos* del Resumen; y mostrar u ocultar el total de cada moneda. En el Resumen cada total tiene un botón *Ocultar* y, si hay uno oculto, aparece *Mostrar total en…*.
- Ocultar solo cambia lo que ves: los datos siguen ahí. Un total oculto sigue contando dentro de tus cuentas e inversiones.

## Fase 5: datos más livianos, papelera, versiones, temas y privacidad

### Datos comprimidos y limpieza del historial
- Cada sincronización guarda una versión del archivo cifrado en el repositorio de datos. Como lo cifrado no se puede comprimir, ahora la app **comprime antes de cifrar**: el archivo queda unas 6 veces más pequeño.
- El formato comprimido solo se usa cuando **todos los dispositivos que han escrito en los últimos 60 días** ya tienen esta versión (cada uno se registra al abrir la app). Abre la app con internet en el PC y en el celular y, desde ese momento, el archivo sube comprimido. Las versiones viejas del archivo se siguen leyendo.
- **Limpieza automática cada 30 días:** se conservan todas las versiones de los últimos 2 días y una por día hasta 90 días; las más viejas se borran del historial. GitHub tarda un tiempo en reflejar el espacio liberado. También puedes usar **Limpiar ahora** en Ajustes → *Papelera y versiones*, donde además ves el tamaño del repositorio.
- Si otro dispositivo sube cambios justo durante la limpieza, la limpieza se cancela sin tocar nada y se intenta después.
- Si tu token no tuviera permiso para reescribir el historial, la app sigue funcionando normal; solo no se limpia.

### Papelera
- Lo que eliminas (movimientos, cuentas, deudas, operaciones de inversión, metas) queda **30 días** en Ajustes → *Papelera*, de donde lo puedes **Recuperar**. Después se borra del todo.
- Lo que se eliminó junto se recupera junto: una cuenta vuelve con sus movimientos, y las deudas u operaciones que la usaban vuelven a quedar asociadas a ella. Una deuda vuelve con sus abonos.
- **Vaciar papelera** la borra de inmediato en todos tus dispositivos.

### Versiones anteriores
- Ajustes → *Versiones anteriores*: la lista de versiones guardadas, con fecha y hora. Al tocar una, la app la descarga, la descifra y te muestra cuántos movimientos, cuentas, deudas, operaciones y metas tenía, comparado con hoy.
- **Restaurar esta versión** deja tus datos exactamente como estaban, en todos tus dispositivos. Antes guarda lo de hoy como otra versión, así que puedes deshacerlo restaurando esa.
- No cambia la configuración de cada dispositivo (tema, vista, clave de precios).

### Tema, color y privacidad (Ajustes → Vista, por dispositivo)
- **Tema:** automático (según el sistema), claro u oscuro.
- **Color:** verde, azul, morado, frambuesa, naranja o grafito. Todos tienen buen contraste en claro y en oscuro. Los gráficos mantienen sus colores.
- **Modo privacidad:** el botón del ojo, junto a Ajustes, cambia todos los montos por `•••••` (tampoco se ven en verde o rojo) hasta que lo vuelvas a tocar. Los porcentajes y las cantidades de acciones siguen visibles, y al abrir un formulario para editar sí ves el monto real. Puedes elegir que la app **abra siempre con los montos ocultos**.
- En celulares angostos el botón de sincronizar queda solo con el ícono ⟳.

## Fase 6: cuotas, búsqueda e importar extractos

### Compras a cuotas
- Al registrar un **gasto con una tarjeta de crédito** aparece **Cuotas** (1 a 48) y, si eliges más de una, el **interés mensual (%)** (vacío o 0 = sin interés). Debajo ves la cuota, la fecha de la primera y el total con intereses.
- La **deuda** de la tarjeta sube por el total el día de la compra (así funciona el cupo). Lo que cambia es **el pago de cada extracto**: cada cuota llega en un corte, empezando por el primer corte desde la compra (si compras el mismo día del corte, entra en ese).
- Con interés se usa **cuota fija** (sistema francés): el interés de cada mes es el saldo pendiente por la tasa. Cuando pasa cada corte, su interés aparece en Movimientos como gasto en **Intereses y comisiones** (categoría nueva), sube la deuda y cuenta en los reportes. Tocarlo abre la compra.
- En el **Resumen**, la sección **Compras a cuotas** muestra cada compra con su próxima cuota y lo que falta, y el total pendiente. Se puede plegar u ocultar en Ajustes → Vista.
- Es un cálculo aproximado: el banco puede redondear distinto o cobrar el primer interés por días. Si tu extracto no coincide, ajusta la tasa.

### Búsqueda y filtros (Movimientos)
- **Buscar** por nota, categoría, cuenta o monto (`12.500` o `12500`), sin importar tildes ni mayúsculas.
- **Filtros:** tipo, categoría (o *Sin categoría*), cuenta y periodo: un mes, todo, o entre dos fechas. Arriba ves cuántos resultados hay y sus totales.
- **Seleccionar varios:** marca movimientos y cámbiales la categoría de una vez, o elimínalos (quedan en la Papelera).

### Importar extractos (CSV o Excel)
1. Movimientos → **Importar extracto**. Elige la cuenta y el archivo (`.csv`, `.xlsx`, `.xls`) que descargaste de tu banco. Se lee solo en tu dispositivo.
2. **Columnas:** la app adivina cuál es la fecha, la descripción y el monto (una columna con signo, o columnas de cargos y abonos) y te muestra cómo va a leer las primeras filas. Corrige lo que haga falta. La próxima vez, con un archivo del mismo formato, usa lo mismo.
3. **Revisión:** cada fila con tipo y categoría. Lo que ya estaba registrado (mismo monto y tipo a ±2 días) y lo que parece un **pago o transferencia** entre tus cuentas quedan sin marcar, para no contarlo dos veces.
4. La categoría que eliges para un comercio se aplica a sus otras filas y se guarda como **regla** («uber trip» → Transporte) para las próximas importaciones. Las reglas se ven y se quitan en Ajustes.
5. Al terminar puedes **Deshacer la importación** (lo importado va a la Papelera) o verlo filtrado en Movimientos.

Los extractos en **PDF** no se pueden leer todavía. Excel se lee con [SheetJS](https://sheetjs.com) 0.18.5 (carpeta `vendor/`, licencia Apache 2.0), que se descarga solo la primera vez que importas un Excel. Importa solo archivos descargados de tu banco.

## Fase 7: comparar con un índice y rebalanceo

Dos secciones nuevas en **Inversiones**, plegables y que se pueden quitar en Ajustes → Vista → *Inversiones*. Solo usan tus posiciones en dólares.

### Comparar con un índice
- Responde: *¿me habría ido mejor poniendo cada compra en un índice?* Cada compra que hiciste se "repite" ese mismo día y por el mismo monto en el ETF del índice; cada venta saca el mismo monto. Así las dos opciones tienen exactamente la misma plata entrando y saliendo.
- Índices (por su ETF, porque el plan gratis trae ETF y no índices): **VOO** (S&P 500), **QQQ** (Nasdaq-100), **DIA** (Dow Jones), **VTI** (mercado total de EE. UU.), **VXUS** (fuera de EE. UU.), **IWM** (Russell 2000), o **＋ Otro** símbolo. Hasta 3 a la vez; por defecto VOO y QQQ. La elección se sincroniza.
- Ves una tabla (valor hoy, ganancia y %), una frase con la diferencia frente al primero ("Vas US$ X por encima de VOO") y la gráfica del valor semana a semana, con *Ver como tabla*.
- Tus dividendos cuentan como ganancia tuya; los del índice no se incluyen (precios de cierre sin dividendos), así que el índice queda un poco por debajo de lo real.
- Necesita la clave de Twelve Data. El historial se pide **una vez al día** y se guarda en el dispositivo: 1 crédito por símbolo (tus acciones + los índices), máximo 8 por consulta. Al agregar un índice solo se pide ese.

### Asignación objetivo y rebalanceo
- **Definir objetivos:** qué % quieres de cada ETF o acción (por ejemplo VOO 60 %, VXUS 20 %). Lo que no tenga objetivo va a **Otras** con el % que sobra. No puede sumar más de 100.
- Cada fila muestra una barra con lo que tienes hoy y una línea con el objetivo, y cuántos puntos (y dólares) te faltan o te sobran. ⚠ si te desvías 5 puntos o más.
- **¿Cuánto vas a invertir ahora?** Escribe el monto y la app sugiere en qué comprar **sin vender nada**: primero lo que más se aleja del objetivo. Tocar una sugerencia abre la compra con el símbolo puesto.

## Pruebas

- `node test-sync.mjs` (Node 18+): dos dispositivos y un GitHub falso (cifrado, contraseña incorrecta, ediciones, borrados, conflictos, respaldo, compresión y limpieza del historial).
- `node test-invest.mjs`: posiciones, costo promedio, fracciones, ventas sin respaldo, patrimonio y lectura de respuestas de precios.
- `node test-import.mjs`: CSV y Excel (separadores, codificación), fechas, montos con signo, columnas, reglas y duplicados.
- `node test-portfolio.mjs`: comparación con índices (mismas compras y ventas), historial, asignación, sugerencia de compra e historial de precios.
- `node test-ledger.mjs`: lectura de montos (`12.500`, `1,234.56`…), saldos, totales del mes, filtros, resumen, papelera, restaurar versiones, cuotas y búsqueda.
