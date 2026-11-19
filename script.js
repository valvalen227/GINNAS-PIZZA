'use strict';

/* =====================================================================
   GINNA'S PIZZA · Frontend
   Todos los datos del negocio viven en PostgreSQL y se consultan/guardan
   con fetch contra la API en C#. Aquí solo hay estado en memoria que se
   rellena desde la API (cachés de lectura) y la sesión activa (token) en
   sessionStorage. No se usa localStorage para datos del negocio.
   ===================================================================== */

const API_BASE = 'http://localhost:5024';
const TASA_IVA = 0.16;
const TAMANOS_PIZZA = ['Personal', 'Mediana', 'Familiar'];
const SESION_STAFF_KEY = 'ginnas.sesion.staff';
const SESION_CLIENTE_KEY = 'ginnas.sesion.cliente';
const REFRESCO_CATALOGO_MS = 30000;
const REFRESCO_PANEL_MS = 15000;

/* ------------------------------ Formato ------------------------------ */

const formatoCOP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const formatoCOPConDecimales = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const formatearCOP = valor => formatoCOP.format(Number(valor) || 0);
const formatearCOPConDecimales = valor => formatoCOPConDecimales.format(Number(valor) || 0);
const redondear2 = valor => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

/* Imagen de respaldo (SVG embebido, funciona sin internet) para fotos que no cargan. */
const IMG_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF8E1"/><stop offset="1" stop-color="#FFE082"/></linearGradient></defs>'
    + '<rect width="800" height="500" fill="url(#g)"/>'
    + '<text x="400" y="290" font-size="190" text-anchor="middle">🍕</text>'
    + '<text x="400" y="400" font-size="34" font-family="sans-serif" font-weight="700" fill="#D81E18" text-anchor="middle">GINNA\'S PIZZA</text></svg>');

/** <img> con proporción fija 16/10 y respaldo automático si la URL falla. */
function imagenHTML(src, alt, clase = 'img-ginnas') {
    return `<img class="${clase}" src="${escaparHTML(src)}" alt="${escaparHTML(alt)}" loading="lazy" onerror="this.onerror=null;this.src=IMG_FALLBACK">`;
}

/* Fotos por defecto de los combos (se usan solo si la promoción no tiene imagen propia). */
const FOTO_UNSPLASH = id => `https://images.unsplash.com/photo-${id}?w=800&q=80`;
const FOTOS_PROMOCIONES = {
    'combo para compartir': FOTO_UNSPLASH('1571407970349-bc81e7e96d47'), // pizza para compartir + Coca-Cola
    'combo personal': FOTO_UNSPLASH('1605478371310-a9f1e96b4ff4'),       // pizza pepperoni
    'combo familiar': FOTO_UNSPLASH('1574071318508-1cdbab80d002')        // pizza napolitana
};
const fotoPromocion = promocion => promocion.imagen || FOTOS_PROMOCIONES[String(promocion.nombre || '').trim().toLowerCase()] || '';

function escaparHTML(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caracter => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[caracter]);
}

/** Fecha local (zona del navegador) como yyyy-mm-dd. Nunca usa toISOString(), que devuelve UTC. */
function fechaLocalISO(fecha = new Date()) {
    return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
}

function claveFechaLocal(valor) {
    const fecha = new Date(valor);
    return Number.isNaN(fecha.getTime()) ? '' : fechaLocalISO(fecha);
}

function formatearFechaComercial(fecha) {
    const valida = new Date(fecha);
    return Number.isNaN(valida.getTime()) ? '—' : valida.toLocaleString('es-CO');
}

function formatearCantidad(valor) {
    return Number(Number(valor).toFixed(3)).toLocaleString('es-CO', { maximumFractionDigits: 3 });
}

/* ------------------------------ Estado ------------------------------ */

/** Cachés de lectura rellenadas desde la API. No se persisten en el navegador. */
const Datos = {
    productos: [],            // catálogo público (solo disponibles)
    disponibilidad: new Map(),// "productoId|tamaño" -> disponibilidad calculada por el servidor
    promociones: [],          // vigentes para la tienda pública
    promocionesInternas: [],  // vigentes para pedidos internos (incluye exclusivas)
    catalogoAdmin: [],        // todos los productos con recetas (administrador)
    promocionesAdmin: [],
    pedidos: [],
    ventas: [],
    ingredientes: [],
    movimientos: [],
    clientes: [],
    proveedores: [],
    usuarios: [],
    reporte: null
};

let errorCatalogo = null;
let cargandoCatalogo = false;
let usuarioActual = null;   // { id, nombre, email, rol, token }
let clienteActual = null;   // { id, nombre, email, rol: 'Cliente', token }
let pedidoCliente = [];
let pedidoModal = [];
let categoriaModalActual = 'Pizzas';
let enviandoPedidoCliente = false;
let pedidoPagoSeleccionadoId = null;
let imagenProductoTemporal = '';
let borradorRecetasProducto = {};
let tamanoRecetaProductoActual = null;
let accionConfirmacionPendiente = null;
let toastNotificacionTimer = null;

/* ------------------------- Sesión (solo token) ------------------------- */

function leerSesionGuardada(clave) {
    try {
        const texto = sessionStorage.getItem(clave);
        return texto ? JSON.parse(texto) : null;
    } catch {
        return null;
    }
}

function guardarSesionLocal(clave, valor) {
    try { sessionStorage.setItem(clave, JSON.stringify(valor)); } catch { /* modo privado o bloqueado: la sesión dura solo en memoria */ }
}

function borrarSesionLocal(clave) {
    try { sessionStorage.removeItem(clave); } catch { /* sin acción */ }
}

/* ------------------------------ Cliente HTTP ------------------------------ */

class ErrorApi extends Error {
    constructor(mensaje, estado = 0) {
        super(mensaje);
        this.estado = estado;
    }
}

/**
 * Llamada a la API.
 * @param {string} ruta
 * @param {{metodo?: string, cuerpo?: any, sesion?: 'staff'|'cliente'|'ninguna', parametros?: Record<string, any>}} opciones
 */
async function api(ruta, { metodo = 'GET', cuerpo, sesion = 'ninguna', parametros } = {}) {
    const url = new URL(API_BASE + ruta);
    Object.entries(parametros || {}).forEach(([clave, valor]) => {
        if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(clave, valor);
    });
    const encabezados = { Accept: 'application/json' };
    if (cuerpo !== undefined) encabezados['Content-Type'] = 'application/json';
    const token = sesion === 'staff' ? usuarioActual?.token : sesion === 'cliente' ? clienteActual?.token : null;
    if (token) encabezados.Authorization = `Bearer ${token}`;

    let respuesta;
    try {
        respuesta = await fetch(url, {
            method: metodo,
            headers: encabezados,
            body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
        });
    } catch (error) {
        console.error('Fallo de red al llamar a la API:', error);
        throw new ErrorApi(`No se pudo conectar con el servidor (${API_BASE}). Verifica que la API esté en ejecución.`, 0);
    }

    let datos = null;
    const texto = await respuesta.text();
    if (texto) {
        try { datos = JSON.parse(texto); } catch { datos = null; }
    }
    if (!respuesta.ok) {
        if (respuesta.status === 401 && token) manejarSesionInvalida(sesion);
        throw new ErrorApi(datos?.error || datos?.title || `Error del servidor (${respuesta.status}).`, respuesta.status);
    }
    return datos;
}

function manejarSesionInvalida(tipo) {
    if (tipo === 'staff' && usuarioActual) {
        limpiarSesionStaff();
        mostrarVista('vistaLogin');
        mostrarErrorLogin('Tu sesión expiró o dejó de ser válida. Inicia sesión nuevamente.');
    } else if (tipo === 'cliente' && clienteActual) {
        clienteActual = null;
        borrarSesionLocal(SESION_CLIENTE_KEY);
        actualizarSesionCliente();
    }
}

/** Ejecuta una tarea asíncrona de un formulario bloqueando su botón hasta que termine (evita envíos dobles). */
async function conBloqueo(evento, tarea) {
    evento?.preventDefault?.();
    const boton = evento?.submitter || evento?.target?.querySelector?.('button[type="submit"]');
    if (boton?.disabled) return undefined;
    if (boton) {
        boton.disabled = true;
        boton.classList.add('is-loading');
        boton.setAttribute('aria-busy', 'true');
    }
    try {
        return await tarea();
    } finally {
        if (boton) {
            boton.disabled = false;
            boton.classList.remove('is-loading');
            boton.removeAttribute('aria-busy');
        }
    }
}

/* ------------------------------ Vistas y avisos ------------------------------ */

function mostrarVista(idVista) {
    if (idVista === 'vistaAdmin' && (!usuarioActual || !normalizarRol(usuarioActual.rol))) {
        alert('Inicia sesión con una cuenta autorizada para acceder.');
        return false;
    }
    document.querySelectorAll('.vista').forEach(v => v.classList.remove('activa'));
    document.getElementById(idVista).classList.add('activa');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
}

function mostrarNotificacion(mensaje, tipo = 'success') {
    const toast = document.getElementById('toastNotificacion');
    toast.textContent = mensaje;
    toast.className = `toast-notificacion activo ${tipo}`;
    clearTimeout(toastNotificacionTimer);
    toastNotificacionTimer = setTimeout(() => toast.classList.remove('activo'), 3600);
}

function cerrarModal(id) {
    const modal = document.getElementById(id);
    modal.classList.remove('activo');
    modal.querySelectorAll('.password-control').forEach(control => {
        const campo = control.querySelector('input');
        if (campo) restablecerVisibilidadPassword(campo);
    });
}

function pedirConfirmacionEntidad(titulo, mensaje, accion, callback) {
    document.getElementById('tituloConfirmacionEntidad').textContent = titulo;
    document.getElementById('mensajeConfirmacionEntidad').textContent = mensaje;
    const boton = document.getElementById('confirmarAccionEntidad');
    boton.textContent = accion;
    accionConfirmacionPendiente = callback;
    boton.onclick = () => {
        const confirmar = accionConfirmacionPendiente;
        cancelarConfirmacionEntidad();
        if (confirmar) confirmar();
    };
    document.getElementById('modalConfirmacionEntidad').classList.add('activo');
}

function cancelarConfirmacionEntidad() {
    accionConfirmacionPendiente = null;
    cerrarModal('modalConfirmacionEntidad');
}

function alternarVisibilidadPassword(id, boton) {
    const campo = document.getElementById(id);
    const mostrar = campo.type === 'password';
    campo.type = mostrar ? 'text' : 'password';
    boton.textContent = mostrar ? 'Ocultar' : 'Mostrar';
    boton.setAttribute('aria-label', `${mostrar ? 'Ocultar' : 'Mostrar'} contraseña`);
}

function restablecerVisibilidadPassword(campo) {
    campo.type = 'password';
    const boton = campo.closest('.password-control')?.querySelector('.password-toggle');
    if (boton) {
        boton.textContent = 'Mostrar';
        boton.setAttribute('aria-label', 'Mostrar contraseña');
    }
}

function mostrarErrorCliente(id, mensaje) {
    const error = document.getElementById(id);
    error.textContent = mensaje;
    error.classList.add('activo');
}

function limpiarErrorCliente(id) {
    const error = document.getElementById(id);
    error.textContent = '';
    error.classList.remove('activo');
}

function badgeEstado(estado) {
    const mapa = {
        'Pendiente': 'badge-warning', 'Confirmado': 'badge-info', 'En preparación': 'badge-info',
        'Listo para entregar': 'badge-brand', 'Entregado': 'badge-success', 'Completada': 'badge-success',
        'Cancelado': 'badge-danger', 'Pagado': 'badge-success', 'Activo': 'badge-success', 'Inactivo': 'badge-danger',
        'Disponible': 'badge-success', 'Stock bajo': 'badge-warning', 'Agotado': 'badge-danger',
        'Entrada': 'badge-success', 'Salida': 'badge-info', 'Ajuste': 'badge-warning'
    };
    return `<span class="badge ${mapa[estado] || 'badge-info'}">${escaparHTML(estado)}</span>`;
}

function resumenProductos(lineas = []) {
    return lineas.map(l => `${l.nombre}${l.tamano ? ` (${l.tamano})` : ''} × ${l.cantidad}`).join(', ');
}

function cantidadProductos(lineas = []) {
    return lineas.reduce((total, linea) => total + Number(linea.cantidad || 0), 0);
}

/* ===================================================================
   TIENDA PÚBLICA: catálogo, disponibilidad y promociones
   =================================================================== */

function precioProducto(producto, tamano = '') {
    if (producto.categoria !== 'Pizzas') return Number(producto.precio);
    const t = tamano || 'Personal';
    return Number(t === 'Mediana' ? producto.precioMediana : t === 'Familiar' ? producto.precioFamiliar : producto.precio);
}

function estadoDisponibilidadProducto(producto, tamano = '') {
    if (!producto || producto.disponible === false) {
        return { disponible: false, estado: 'unavailable', maximo: 0, motivo: 'Producto no disponible.' };
    }
    if (cargandoCatalogo && Datos.disponibilidad.size === 0) {
        return { disponible: false, estado: 'not-verifiable', maximo: null, motivo: 'Verificando inventario...' };
    }
    const tamanoClave = producto.categoria === 'Pizzas' ? (tamano || 'Personal') : '';
    const respuesta = Datos.disponibilidad.get(`${producto.id}|${tamanoClave}`);
    if (!respuesta) {
        return { disponible: false, estado: 'not-verifiable', maximo: null, motivo: errorCatalogo || 'El servidor no informó la disponibilidad de este producto.' };
    }
    const maximo = respuesta.maximumQuantity ?? null;
    return {
        disponible: respuesta.available && respuesta.status === 'available' && Number.isInteger(maximo) && maximo > 0,
        estado: respuesta.status,
        maximo,
        motivo: respuesta.reason || (respuesta.available ? '' : 'No hay existencias suficientes.')
    };
}

function estadoDisponibilidadComponentes(componentes = []) {
    let maximo = Infinity;
    for (const componente of componentes) {
        const producto = Datos.productos.find(p => p.id === componente.productoId);
        const estado = estadoDisponibilidadProducto(producto, componente.tamano || '');
        if (!estado.disponible || estado.maximo == null || estado.maximo < componente.cantidad) {
            return { disponible: false, maximo: 0, motivo: `${componente.producto || 'Un producto del combo'}: ${estado.disponible ? 'existencias insuficientes' : estado.motivo}` };
        }
        maximo = Math.min(maximo, Math.floor(estado.maximo / componente.cantidad));
    }
    const valido = componentes.length > 0 && Number.isFinite(maximo) && maximo > 0;
    return {
        disponible: valido,
        maximo: valido ? maximo : 0,
        motivo: valido ? `Disponibles hasta ${maximo} combo(s).` : 'No se pudieron validar los componentes del combo.'
    };
}

function actualizarAvisoDisponibilidadCatalogo() {
    const aviso = document.getElementById('catalogoDisponibilidadAviso');
    if (!aviso) return;
    if (errorCatalogo) {
        aviso.className = 'catalogo-aviso error';
        aviso.innerHTML = `${escaparHTML(errorCatalogo)} <button type="button" class="btn btn-ghost btn-sm" onclick="cargarCatalogo()">Reintentar</button>`;
        aviso.hidden = false;
        return;
    }
    const sinVerificar = Datos.productos.filter(p => p.disponible && estadoDisponibilidadProducto(p, p.categoria === 'Pizzas' ? 'Personal' : '').estado === 'not-verifiable');
    if (sinVerificar.length) {
        aviso.className = 'catalogo-aviso';
        aviso.textContent = `Algunos productos aún no tienen receta o inventario configurado y no pueden pedirse: ${sinVerificar.map(p => p.nombre).join(', ')}.`;
        aviso.hidden = false;
        return;
    }
    aviso.hidden = true;
    aviso.textContent = '';
}

async function cargarCatalogo({ silencioso = false } = {}) {
    if (cargandoCatalogo) return;
    cargandoCatalogo = true;
    if (!silencioso && Datos.productos.length === 0) {
        document.getElementById('productosGrid').innerHTML = '<p class="estado-carga">Cargando menú…</p>';
    }
    try {
        const [productos, disponibilidad] = await Promise.all([
            api('/api/productos'),
            api('/api/productos/disponibilidad')
        ]);
        Datos.productos = productos;
        Datos.disponibilidad = new Map(disponibilidad.map(d => [`${d.productId}|${d.size}`, d]));
        errorCatalogo = null;
    } catch (error) {
        console.error('No se pudo cargar el catálogo:', error);
        errorCatalogo = `No se pudo cargar el menú: ${error.message}`;
    }
    try {
        Datos.promociones = await api('/api/promociones/vigentes', { sesion: clienteActual ? 'cliente' : 'ninguna' });
    } catch (error) {
        console.error('No se pudieron cargar las promociones:', error);
        Datos.promociones = [];
    }
    cargandoCatalogo = false;
    actualizarAvisoDisponibilidadCatalogo();
    renderizarProductosPublicos(categoriaPublicaActiva());
    renderizarOfertasPublicas();
    revalidarCarrito(pedidoCliente);
    renderizarPedidoCliente();
    if (document.getElementById('modalPedido')?.classList.contains('activo')) renderizarProductosModalPedido();
}

function categoriaPublicaActiva() {
    return document.querySelector('.categorias-barra .categoria-btn.activa')?.dataset.categoria || 'todas';
}

/** Quita del carrito líneas cuyo producto/combo ya no existe o dejó de estar disponible. */
function revalidarCarrito(carrito) {
    if (cargandoCatalogo || errorCatalogo) return;
    for (let i = carrito.length - 1; i >= 0; i--) {
        const linea = carrito[i];
        if (linea.esPromocion) {
            const vigente = Datos.promociones.some(p => p.id === linea.promocionId);
            if (!vigente && carrito === pedidoCliente) carrito.splice(i, 1);
        } else if (!Datos.productos.some(p => p.id === linea.productoId)) {
            carrito.splice(i, 1);
        }
    }
}

function htmlTarjetaProducto(p, prefijo, alAgregar) {
    const esPizza = p.categoria === 'Pizzas';
    const tamanoInicial = esPizza ? 'Personal' : '';
    const estado = estadoDisponibilidadProducto(p, tamanoInicial);
    const textoDisp = estado.disponible && estado.maximo != null
        ? `Disponible: hasta ${estado.maximo} unidad(es)${tamanoInicial ? ` ${tamanoInicial}` : ''}.`
        : estado.motivo;
    return `
        <div id="${prefijo}producto-card-${p.id}" class="producto-card ${estado.disponible ? '' : 'producto-no-disponible'}">
            <div class="producto-imagen">${p.imagen ? imagenHTML(p.imagen, p.nombre) : escaparHTML(p.emoji || '🍕')}</div>
            <div class="producto-nombre">${escaparHTML(p.nombre)}${mostrarPresentacion(p) ? ` · ${escaparHTML(p.presentacion)}` : ''}</div>
            <div class="producto-descripcion">${escaparHTML(p.descripcion || '')}</div>
            <div id="${prefijo}producto-disponibilidad-${p.id}" class="producto-disponibilidad" role="status" ${estado.disponible ? 'hidden' : ''}>${escaparHTML(textoDisp)}</div>
            ${esPizza ? `
                <label class="pizza-tamano-control" for="${prefijo}tamano-${p.id}">
                    Tamaño
                    <select id="${prefijo}tamano-${p.id}" class="form-input" onchange="actualizarPrecioPizza(${p.id}, this.value, '${prefijo}')">
                        ${TAMANOS_PIZZA.map(t => `<option value="${t}" ${t === 'Personal' ? 'selected' : ''}>${t}</option>`).join('')}
                    </select>
                </label>` : ''}
            <div class="producto-footer">
                <div class="producto-precio" id="${prefijo}precio-${p.id}">${formatearCOP(precioProducto(p, tamanoInicial))}</div>
                <button id="${prefijo}producto-agregar-${p.id}" class="btn-agregar" onclick="${alAgregar}(${p.id}, this)" ${estado.disponible ? '' : 'disabled'}>${textoBotonAgregar(estado)}</button>
            </div>
        </div>`;
}

/** La presentación solo se muestra si aporta información (no se repite en el nombre ni es genérica). */
function mostrarPresentacion(p) {
    const presentacion = String(p.presentacion || '').trim();
    if (!presentacion || p.categoria === 'Pizzas') return false;
    const compacto = texto => texto.toLowerCase().replace(/\s+/g, '');
    return !['unidad', 'porción', 'porcion'].includes(presentacion.toLowerCase())
        && !compacto(p.nombre).includes(compacto(presentacion));
}

function textoBotonAgregar(estado) {
    return estado.disponible ? '+ Agregar' : estado.estado === 'not-verifiable' ? 'Sin verificar' : 'No disponible';
}

function actualizarPrecioPizza(id, tamano, prefijo = '') {
    const producto = Datos.productos.find(item => item.id === id);
    const precio = document.getElementById(`${prefijo}precio-${id}`);
    if (producto && precio) precio.textContent = formatearCOP(precioProducto(producto, tamano));
    const estado = estadoDisponibilidadProducto(producto, tamano);
    const tarjeta = document.getElementById(`${prefijo}producto-card-${id}`);
    const aviso = document.getElementById(`${prefijo}producto-disponibilidad-${id}`);
    const boton = document.getElementById(`${prefijo}producto-agregar-${id}`);
    if (!tarjeta || !aviso || !boton) return;
    tarjeta.classList.toggle('producto-no-disponible', !estado.disponible);
    aviso.hidden = estado.disponible;
    aviso.textContent = estado.disponible && estado.maximo != null ? `Disponible: hasta ${estado.maximo} unidad(es) ${tamano}.` : estado.motivo;
    boton.disabled = !estado.disponible;
    boton.textContent = textoBotonAgregar(estado);
}

function renderizarProductosPublicos(categoria = 'todas') {
    const grid = document.getElementById('productosGrid');
    if (errorCatalogo && Datos.productos.length === 0) {
        grid.innerHTML = `<p class="estado-carga">${escaparHTML(errorCatalogo)}</p>`;
        return;
    }
    const lista = categoria === 'todas' ? Datos.productos : Datos.productos.filter(p => p.categoria === categoria);
    grid.innerHTML = lista.length
        ? lista.map(p => htmlTarjetaProducto(p, '', 'agregarAPedido')).join('')
        : '<p class="estado-carga">No hay productos disponibles en esta categoría.</p>';
}

function filtrarCategoria(categoria, boton) {
    document.querySelectorAll('.categorias-barra .categoria-btn').forEach(b => b.classList.remove('activa'));
    boton.classList.add('activa');
    renderizarProductosPublicos(categoria);
}

/* ------------------------------ Carrito (lógica compartida) ------------------------------ */

function agregarProductoACarrito(carrito, producto, tamano) {
    const estado = estadoDisponibilidadProducto(producto, tamano);
    if (!estado.disponible) return { ok: false, mensaje: `${producto.nombre} no se puede pedir. ${estado.motivo}` };
    const clave = `prod-${producto.id}-${tamano}`;
    const existente = carrito.find(l => l.clave === clave);
    const cantidad = (existente?.cantidad || 0) + 1;
    if (estado.maximo != null && cantidad > estado.maximo) {
        return { ok: false, mensaje: `Solo hay ${estado.maximo} unidad(es) disponibles de ${producto.nombre}${tamano ? ` ${tamano}` : ''}.` };
    }
    if (existente) {
        existente.cantidad = cantidad;
    } else {
        const precio = precioProducto(producto, tamano);
        carrito.push({
            clave, productoId: producto.id, promocionId: null, esPromocion: false, nombre: producto.nombre,
            tamano, emoji: producto.emoji || '🍕', categoria: producto.categoria,
            precioNormal: precio, descuentoUnitario: 0, precio, cantidad: 1
        });
    }
    return { ok: true };
}

function agregarPromocionACarrito(carrito, promocion) {
    const estado = estadoDisponibilidadComponentes(promocion.componentes);
    if (!estado.disponible) return { ok: false, mensaje: `Este combo no se puede agregar: ${estado.motivo}` };
    const clave = `promo-${promocion.id}`;
    const existente = carrito.find(l => l.clave === clave);
    if (estado.maximo != null && (existente?.cantidad || 0) + 1 > estado.maximo) {
        return { ok: false, mensaje: `Solo hay ingredientes para preparar ${estado.maximo} combo(s).` };
    }
    if (existente) {
        existente.cantidad++;
    } else {
        carrito.push({
            clave, productoId: null, promocionId: promocion.id, esPromocion: true,
            esOfertaCliente: promocion.publico === 'clientes', nombre: promocion.nombre, tamano: '',
            emoji: promocion.emoji || '🎁', categoria: 'Combos', componentes: promocion.componentes,
            precioNormal: promocion.precioNormal, descuentoUnitario: promocion.descuento,
            precio: promocion.precioFinal, cantidad: 1
        });
    }
    return { ok: true };
}

/** Cambia la cantidad de una línea validando disponibilidad. Devuelve { ok, mensaje }. */
function cambiarCantidadEnCarrito(carrito, clave, delta) {
    const linea = carrito.find(l => l.clave === clave);
    if (!linea) return { ok: false };
    if (delta > 0) {
        const estado = linea.esPromocion
            ? estadoDisponibilidadComponentes(linea.componentes)
            : estadoDisponibilidadProducto(Datos.productos.find(p => p.id === linea.productoId), linea.tamano);
        if (!estado.disponible) return { ok: false, mensaje: `No se puede aumentar este producto. ${estado.motivo}` };
        if (estado.maximo != null && linea.cantidad + delta > estado.maximo) {
            return { ok: false, mensaje: `Solo puedes pedir ${estado.maximo} unidad(es) de este producto con el inventario actual.` };
        }
    }
    linea.cantidad += delta;
    if (linea.cantidad <= 0) carrito.splice(carrito.indexOf(linea), 1);
    return { ok: true };
}

/** Misma regla de totales que usa el servidor: IVA 16 % sobre (subtotal − descuento). */
function calcularTotales(lineas) {
    const subtotal = redondear2(lineas.reduce((s, l) => s + l.precioNormal * l.cantidad, 0));
    const descuento = redondear2(Math.min(subtotal, lineas.reduce((s, l) => s + l.descuentoUnitario * l.cantidad, 0)));
    const base = subtotal - descuento;
    const iva = redondear2(base * TASA_IVA);
    return { subtotal, descuento, iva, total: redondear2(base + iva) };
}

function lineasParaApi(carrito) {
    return carrito.map(l => l.esPromocion
        ? { promocionId: l.promocionId, cantidad: l.cantidad }
        : { productoId: l.productoId, tamano: l.tamano || null, cantidad: l.cantidad });
}

/* ------------------------------ Carrito de la tienda ------------------------------ */

function agregarAPedido(id, boton) {
    const producto = Datos.productos.find(p => p.id === id);
    if (!producto) return;
    const selector = producto.categoria === 'Pizzas' ? document.getElementById(`tamano-${id}`) : null;
    const resultado = agregarProductoACarrito(pedidoCliente, producto, selector ? selector.value : '');
    if (!resultado.ok) {
        mostrarNotificacion(resultado.mensaje, 'error');
        return;
    }
    renderizarPedidoCliente();
    if (boton) {
        const original = boton.textContent;
        boton.textContent = '✓ Agregado';
        boton.style.background = 'var(--success)';
        setTimeout(() => {
            boton.textContent = original;
            boton.style.background = '';
        }, 800);
    }
}

function agregarPromocionAPedido(id) {
    const promocion = Datos.promociones.find(p => p.id === id);
    if (!promocion) {
        mostrarNotificacion('Esta promoción ya no está disponible.', 'error');
        cargarCatalogo({ silencioso: true });
        return;
    }
    if (promocion.publico === 'clientes' && !clienteActual) {
        mostrarNotificacion('Inicia sesión para usar esta oferta exclusiva.', 'error');
        abrirLoginCliente();
        return;
    }
    const resultado = agregarPromocionACarrito(pedidoCliente, promocion);
    if (!resultado.ok) mostrarNotificacion(resultado.mensaje, 'error');
    renderizarPedidoCliente();
}

function cambiarCantidadPedido(clave, delta) {
    const resultado = cambiarCantidadEnCarrito(pedidoCliente, clave, delta);
    if (resultado.mensaje) mostrarNotificacion(resultado.mensaje, 'error');
    renderizarPedidoCliente();
}

function eliminarDelPedido(clave) {
    pedidoCliente = pedidoCliente.filter(l => l.clave !== clave);
    renderizarPedidoCliente();
}

function vaciarPedido() {
    if (pedidoCliente.length === 0) return;
    if (confirm('¿Vaciar todo el pedido?')) {
        pedidoCliente = [];
        renderizarPedidoCliente();
    }
}

function renderizarPedidoCliente() {
    const itemsDiv = document.getElementById('pedidoItems');
    const vacioDiv = document.getElementById('pedidoVacio');
    const footerDiv = document.getElementById('panelPedidoFooter');
    document.getElementById('contadorItems').textContent = pedidoCliente.reduce((s, l) => s + l.cantidad, 0);

    if (pedidoCliente.length === 0) {
        vacioDiv.style.display = 'block';
        footerDiv.style.display = 'none';
        itemsDiv.innerHTML = '';
        actualizarFormularioDomicilio();
        return;
    }
    vacioDiv.style.display = 'none';
    footerDiv.style.display = 'block';
    actualizarFormularioDomicilio();

    itemsDiv.innerHTML = pedidoCliente.map(l => {
        const clave = escaparHTML(l.clave);
        return `
        <div class="pedido-item">
            <div class="pedido-item-emoji">${escaparHTML(l.emoji)}</div>
            <div class="pedido-item-info">
                <div class="pedido-item-nombre">${escaparHTML(l.nombre)}${l.tamano ? ` · ${escaparHTML(l.tamano)}` : ''}</div>
                ${l.esPromocion ? `<div class="pedido-item-detalle">Incluye: ${escaparHTML(resumenProductos(l.componentes.map(c => ({ nombre: c.producto, tamano: c.tamano, cantidad: c.cantidad }))))}</div>` : ''}
                <div class="pedido-item-precio">${formatearCOP(l.precio)} c/u</div>
                ${l.descuentoUnitario ? `<div class="pedido-item-descuento">−${formatearCOP(l.descuentoUnitario)} · Normal ${formatearCOP(l.precioNormal)}</div>` : ''}
                <div class="pedido-item-subtotal">Subtotal: ${formatearCOP(l.precio * l.cantidad)}</div>
            </div>
            <div class="pedido-item-controles">
                <button class="pedido-item-btn" onclick="cambiarCantidadPedido('${clave}', -1)" aria-label="Quitar una unidad">−</button>
                <span class="pedido-item-cantidad">${l.cantidad}</span>
                <button class="pedido-item-btn" onclick="cambiarCantidadPedido('${clave}', 1)" aria-label="Agregar una unidad">+</button>
            </div>
            <button class="pedido-item-eliminar" onclick="eliminarDelPedido('${clave}')" aria-label="Eliminar">✕</button>
        </div>`;
    }).join('');

    const totales = calcularTotales(pedidoCliente);
    document.getElementById('resumenSubtotal').textContent = formatearCOPConDecimales(totales.subtotal);
    document.getElementById('resumenDescuento').textContent = `− ${formatearCOPConDecimales(totales.descuento)}`;
    document.getElementById('resumenIva').textContent = formatearCOPConDecimales(totales.iva);
    document.getElementById('resumenTotal').textContent = formatearCOPConDecimales(totales.total);
}

function actualizarFormularioDomicilio() {
    const tipo = document.getElementById('tipoPedidoCliente')?.value;
    const formulario = document.getElementById('formularioDomicilioCliente');
    if (!formulario) return;
    const esDomicilio = tipo === 'Domicilio';
    formulario.hidden = !esDomicilio;
    ['domicilioNombre', 'domicilioTelefono', 'domicilioDireccion', 'domicilioBarrio', 'domicilioMedioPago'].forEach(id => {
        const campo = document.getElementById(id);
        if (campo) campo.required = esDomicilio;
    });
    if (!esDomicilio) {
        document.getElementById('errorFormularioDomicilio').hidden = true;
        document.getElementById('errorFormularioDomicilio').textContent = '';
    }
}

function obtenerDatosDomicilio() {
    const nombre = document.getElementById('domicilioNombre').value.trim();
    const telefono = document.getElementById('domicilioTelefono').value.trim();
    const direccion = document.getElementById('domicilioDireccion').value.trim();
    const barrio = document.getElementById('domicilioBarrio').value.trim();
    const digitos = telefono.replace(/\D/g, '');
    const medioPago = document.getElementById('domicilioMedioPago').value;
    const error = document.getElementById('errorFormularioDomicilio');
    error.hidden = true;
    error.textContent = '';

    if (nombre.length < 2) error.textContent = 'Ingresa el nombre de la persona que recibirá el pedido.';
    else if (digitos.length < 7 || digitos.length > 15) error.textContent = 'Ingresa un teléfono válido con entre 7 y 15 dígitos.';
    else if (direccion.length < 5) error.textContent = 'Ingresa una dirección completa para realizar la entrega.';
    else if (barrio.length < 2) error.textContent = 'Ingresa el barrio de la entrega.';
    else if (!medioPago) error.textContent = 'Selecciona el medio de pago previsto para el pedido.';
    if (error.textContent) {
        error.hidden = false;
        error.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return null;
    }
    return {
        nombreRecibe: nombre,
        telefonoEntrega: telefono,
        direccionEntrega: direccion,
        barrioEntrega: barrio,
        indicacionesEntrega: document.getElementById('domicilioIndicaciones').value.trim(),
        observaciones: document.getElementById('domicilioObservaciones').value.trim(),
        medioPagoSolicitado: medioPago
    };
}

async function finalizarPedido() {
    if (enviandoPedidoCliente) return;
    if (pedidoCliente.length === 0) {
        alert('⚠️ Tu pedido está vacío');
        return;
    }
    const tipoPedido = document.getElementById('tipoPedidoCliente').value;
    const datosDomicilio = tipoPedido === 'Domicilio' ? obtenerDatosDomicilio() : null;
    if (tipoPedido === 'Domicilio' && !datosDomicilio) return;

    enviandoPedidoCliente = true;
    const botonEnviar = document.querySelector('.panel-pedido-acciones .btn-primary');
    if (botonEnviar) botonEnviar.disabled = true;
    try {
        // Los combos exclusivos exigen una sesión de cliente vigente.
        if (!clienteActual && pedidoCliente.some(l => l.esOfertaCliente)) {
            pedidoCliente = pedidoCliente.filter(l => !l.esOfertaCliente);
            renderizarPedidoCliente();
            alert('Los combos exclusivos requieren una sesión de cliente activa y se quitaron del carrito.');
            return;
        }
        const resultado = await api('/api/pedidos/web', {
            metodo: 'POST',
            sesion: clienteActual ? 'cliente' : 'ninguna',
            cuerpo: {
                tipo: tipoPedido,
                cliente: clienteActual?.nombre || 'Cliente visitante',
                clienteCorreo: clienteActual?.email || '',
                ...(datosDomicilio || {}),
                productos: lineasParaApi(pedidoCliente)
            }
        });
        pedidoCliente = [];
        renderizarPedidoCliente();
        alert(`✅ Pedido registrado correctamente desde la página web.\n\nReferencia: ${resultado.codigo}\nTotal (IVA incluido): ${formatearCOPConDecimales(resultado.total)}\nEl personal autorizado ya puede verlo en el módulo de pedidos.`);
        await cargarCatalogo({ silencioso: true });
    } catch (error) {
        alert(`No fue posible registrar el pedido.\n${error.message}\n\nTu carrito se conservó para que puedas ajustarlo.`);
        cargarCatalogo({ silencioso: true });
    } finally {
        enviandoPedidoCliente = false;
        if (botonEnviar) botonEnviar.disabled = false;
    }
}

/* ------------------------------ Ofertas públicas ------------------------------ */

function renderizarOfertasClientes(promociones, grid) {
    grid.innerHTML = promociones.map(promocion => {
        const disponibilidad = estadoDisponibilidadComponentes(promocion.componentes);
        return `
        <article class="oferta-card">
            <div class="oferta-imagen">${fotoPromocion(promocion) ? imagenHTML(fotoPromocion(promocion), promocion.nombre) : escaparHTML(promocion.emoji || '🎁')}</div>
            <div class="oferta-detalle">
                <div class="oferta-nombre-linea"><h4>${escaparHTML(promocion.nombre)}</h4><span class="oferta-descuento">−${formatearCOP(promocion.descuento)}</span></div>
                <p>${escaparHTML(promocion.descripcion)}</p>
                <p>Incluye: ${escaparHTML(resumenProductos(promocion.componentes.map(c => ({ nombre: c.producto, tamano: c.tamano, cantidad: c.cantidad }))))}</p>
                <div class="oferta-precios"><del>Normal ${formatearCOP(promocion.precioNormal)}</del><strong>${formatearCOP(promocion.precioFinal)}</strong></div>
                ${disponibilidad.disponible ? '' : `<div class="producto-disponibilidad" role="status">${escaparHTML(disponibilidad.motivo)}</div>`}
                <button class="btn btn-primary btn-sm" type="button" onclick="agregarPromocionAPedido(${promocion.id})" ${disponibilidad.disponible ? '' : 'disabled'}>${disponibilidad.disponible ? 'Agregar combo al carrito' : 'No disponible'}</button>
            </div>
        </article>`;
    }).join('');
}

function renderizarOfertasPublicas() {
    const generales = Datos.promociones.filter(p => p.publico === 'general');
    const exclusivas = clienteActual ? Datos.promociones.filter(p => p.publico === 'clientes') : [];
    document.getElementById('promocionesPublicas').hidden = generales.length === 0;
    document.getElementById('ofertasExclusivas').hidden = !clienteActual || exclusivas.length === 0;
    document.getElementById('mensajeOfertasExclusivas').hidden = true;
    renderizarOfertasClientes(generales, document.getElementById('promocionesPublicasGrid'));
    renderizarOfertasClientes(exclusivas, document.getElementById('ofertasGrid'));
}

/* ------------------------------ Cuenta de cliente ------------------------------ */

function abrirLoginCliente() {
    limpiarErrorCliente('loginClienteError');
    document.getElementById('modalLoginCliente').classList.add('activo');
}

function abrirRegistroCliente() {
    cerrarModal('modalLoginCliente');
    limpiarErrorCliente('registroClienteError');
    document.getElementById('modalRegistroCliente').classList.add('activo');
}

function abrirLoginDesdeRegistro() {
    cerrarModal('modalRegistroCliente');
    abrirLoginCliente();
}

function iniciarSesionCliente(evento) {
    return conBloqueo(evento, async () => {
        limpiarErrorCliente('loginClienteError');
        const passwordInput = document.getElementById('contrasenaCliente');
        try {
            const respuesta = await api('/api/clientes/login', {
                metodo: 'POST',
                cuerpo: { correo: document.getElementById('correoCliente').value.trim(), password: passwordInput.value }
            });
            clienteActual = { ...respuesta.cliente, token: respuesta.token };
            guardarSesionLocal(SESION_CLIENTE_KEY, clienteActual);
            cerrarModal('modalLoginCliente');
            await actualizarSesionCliente();
            await cargarCatalogo({ silencioso: true });
        } catch (error) {
            mostrarErrorCliente('loginClienteError', error.message);
        } finally {
            passwordInput.value = '';
            restablecerVisibilidadPassword(passwordInput);
        }
    });
}

function registrarCliente(evento) {
    return conBloqueo(evento, async () => {
        limpiarErrorCliente('registroClienteError');
        const formulario = evento.target;
        const correo = document.getElementById('correoRegistroCliente').value.trim();
        try {
            await api('/api/clientes/registro', {
                metodo: 'POST',
                cuerpo: {
                    nombre: document.getElementById('nombreRegistroCliente').value.trim(),
                    correo,
                    password: document.getElementById('contrasenaRegistroCliente').value
                }
            });
            cerrarModal('modalRegistroCliente');
            formulario.reset();
            document.getElementById('correoCliente').value = correo;
            mostrarNotificacion('Cuenta creada. Ahora puedes iniciar sesión.');
            abrirLoginCliente();
        } catch (error) {
            mostrarErrorCliente('registroClienteError', error.message);
            const campo = document.getElementById('contrasenaRegistroCliente');
            campo.value = '';
            restablecerVisibilidadPassword(campo);
        }
    });
}

async function actualizarSesionCliente() {
    const acciones = document.getElementById('accionesSesionCliente');
    if (!clienteActual) {
        acciones.innerHTML = `
            <button class="btn btn-registro" onclick="abrirLoginCliente()">👤 Iniciar sesión</button>
            <button class="btn btn-secondary" onclick="abrirRegistroCliente()">Registrarme</button>`;
        pedidoCliente = pedidoCliente.filter(l => !l.esOfertaCliente);
    } else {
        acciones.innerHTML = `
            <span class="cliente-sesion-nombre">${escaparHTML(clienteActual.nombre)}</span>
            <button class="btn btn-registro" onclick="cerrarSesionCliente()">Cerrar sesión</button>`;
    }
    renderizarOfertasPublicas();
    renderizarPedidoCliente();
}

async function cerrarSesionCliente() {
    clienteActual = null;
    borrarSesionLocal(SESION_CLIENTE_KEY);
    await actualizarSesionCliente();
    await cargarCatalogo({ silencioso: true });
}

async function restaurarSesionCliente() {
    const guardada = leerSesionGuardada(SESION_CLIENTE_KEY);
    if (!guardada?.token) return;
    clienteActual = guardada;
    try {
        const datos = await api('/api/clientes/me', { sesion: 'cliente' });
        clienteActual = { ...guardada, ...datos };
    } catch (error) {
        if (error.estado === 0) return; // sin conexión: se conserva y se reintenta luego
        clienteActual = null;
        borrarSesionLocal(SESION_CLIENTE_KEY);
    }
}

/* ===================================================================
   SESIÓN DEL PERSONAL, ROLES Y NAVEGACIÓN DEL PANEL
   =================================================================== */

const MODULOS_INFO = {
    dashboard: ['Dashboard', 'Resumen general del negocio'],
    ventas: ['Ventas (TPS)', 'Historial de ventas completadas'],
    pedidos: ['Pedidos (TPS)', 'Preparación y entrega de pedidos'],
    inventario: ['Inventario (TPS)', 'Control de existencias'],
    productos: ['Productos (TPS)', 'Catálogo de productos'],
    promociones: ['Combos y promociones', 'Administración de ofertas'],
    clientes: ['Clientes (TPS)', 'Registro y consulta'],
    proveedores: ['Proveedores (TPS)', 'Información de proveedores'],
    usuarios: ['Usuarios (TPS)', 'Gestión de cuentas'],
    reportes: ['Reportes (MIS)', 'Indicadores gerenciales']
};

const MODULOS_POR_ROL = {
    Administrador: Object.keys(MODULOS_INFO),
    Cajero: ['dashboard', 'ventas', 'pedidos', 'clientes'],
    Mesera: ['dashboard', 'pedidos', 'clientes']
};

function normalizarRol(rol) {
    const valor = String(rol || '').trim().toLowerCase();
    if (valor === 'admin' || valor === 'administrador') return 'Administrador';
    if (valor === 'cajero' || valor === 'cajera') return 'Cajero';
    if (valor === 'mesera') return 'Mesera';
    return null;
}

function etiquetaRol(rol) {
    return ({ Administrador: 'Administrador', Cajero: 'Cajero', Mesera: 'Mesera' })[normalizarRol(rol)] || 'Rol sin asignar';
}

function puedeAccederModulo(modulo, usuario = usuarioActual) {
    const rol = normalizarRol(usuario?.rol);
    return Boolean(rol && MODULOS_POR_ROL[rol]?.includes(modulo));
}

function exigirModulo(modulo, accion) {
    if (puedeAccederModulo(modulo)) return true;
    alert(`Acceso rechazado: tu rol no puede ${accion}.`);
    return false;
}

function esAdministradorActual() {
    return normalizarRol(usuarioActual?.rol) === 'Administrador';
}

function exigirAdministrador(accion) {
    if (esAdministradorActual()) return true;
    alert(`Acceso rechazado: solo un administrador puede ${accion}.`);
    return false;
}

function mostrarLogin() {
    mostrarVista('vistaLogin');
}

function volverAPublico() {
    document.getElementById('loginError').classList.remove('activo');
    mostrarVista('vistaCliente');
}

function mostrarErrorLogin(mensaje) {
    const error = document.getElementById('loginError');
    error.textContent = mensaje;
    error.classList.add('activo');
}

function iniciarSesion(evento) {
    return conBloqueo(evento, async () => {
        const passwordInput = document.getElementById('loginPassword');
        document.getElementById('loginError').classList.remove('activo');
        try {
            const respuesta = await api('/api/auth/login', {
                metodo: 'POST',
                cuerpo: {
                    correo: document.getElementById('loginEmail').value.trim().toLowerCase(), // correo o usuario (admin, cajero, mesera)
                    password: passwordInput.value
                }
            });
            const rol = normalizarRol(respuesta.usuario.rol);
            if (!rol) throw new ErrorApi('Esta cuenta no tiene un rol válido asignado.');
            usuarioActual = { id: respuesta.usuario.id, nombre: respuesta.usuario.nombre, email: respuesta.usuario.correo, rol, token: respuesta.token };
            guardarSesionLocal(SESION_STAFF_KEY, usuarioActual);
            await entrarAlPanel();
        } catch (error) {
            usuarioActual = null;
            mostrarErrorLogin(error.message || 'No fue posible validar la cuenta.');
        } finally {
            passwordInput.value = '';
            restablecerVisibilidadPassword(passwordInput);
        }
    });
}

async function entrarAlPanel() {
    document.getElementById('adminNombre').textContent = usuarioActual.nombre;
    document.getElementById('adminRol').textContent = etiquetaRol(usuarioActual.rol);
    document.getElementById('pedidosModuloSubtitulo').textContent = usuarioActual.rol === 'Mesera'
        ? 'El personal de mesas registra pedidos y consulta su preparación'
        : 'Registra y consulta pedidos recibidos; el pago se registra por separado';
    document.getElementById('adminAvatar').textContent = usuarioActual.nombre.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    mostrarVista('vistaAdmin');
    aplicarPermisosUsuario(usuarioActual);
    await cargarDatosPanel();
    renderizarTodoAdmin();
}

async function restaurarSesionStaff() {
    const guardada = leerSesionGuardada(SESION_STAFF_KEY);
    if (!guardada?.token) return false;
    usuarioActual = guardada;
    try {
        const datos = await api('/api/auth/me', { sesion: 'staff' });
        const rol = normalizarRol(datos.rol);
        if (!rol) throw new ErrorApi('Rol no válido.', 403);
        usuarioActual = { ...guardada, id: datos.id, nombre: datos.nombre, email: datos.correo, rol };
        guardarSesionLocal(SESION_STAFF_KEY, usuarioActual);
        await entrarAlPanel();
        return true;
    } catch (error) {
        if (error.estado === 0) {
            usuarioActual = null; // API apagada: se conserva el token para el próximo intento
            return false;
        }
        if (usuarioActual) limpiarSesionStaff();
        return false;
    }
}

function limpiarSesionStaff() {
    usuarioActual = null;
    borrarSesionLocal(SESION_STAFF_KEY);
    limpiarPermisosSesion();
    cerrarMenuLateral();
    Object.assign(Datos, {
        catalogoAdmin: [], promocionesAdmin: [], promocionesInternas: [], pedidos: [], ventas: [], ingredientes: [],
        movimientos: [], clientes: [], proveedores: [], usuarios: [], reporte: null
    });
    pedidoModal = [];
    document.querySelectorAll('canvas').forEach(canvas => {
        if (canvas._chart) {
            canvas._chart.destroy();
            canvas._chart = null;
        }
    });
    ['adminNombre', 'adminRol', 'adminAvatar'].forEach(id => { document.getElementById(id).textContent = ''; });
    const passwordInput = document.getElementById('loginPassword');
    passwordInput.value = '';
    restablecerVisibilidadPassword(passwordInput);
}

function cerrarSesion() {
    if (!confirm('¿Seguro que deseas cerrar sesión?')) return;
    limpiarSesionStaff();
    document.getElementById('loginError').classList.remove('activo');
    mostrarVista('vistaLogin');
}

function aplicarPermisosUsuario(usuario) {
    const rol = normalizarRol(usuario?.rol);
    const permitidos = new Set(MODULOS_POR_ROL[rol] || []);
    document.querySelector('.sidebar-subtitulo').textContent = ({
        Administrador: 'Panel administrativo', Cajero: 'Personal de caja', Mesera: 'Personal de mesas'
    })[rol] || 'Sistema';
    const navegacion = document.querySelector('.sidebar-nav');
    navegacion.querySelectorAll('.nav-item').forEach(boton => { boton.hidden = !permitidos.has(boton.dataset.modulo); });
    navegacion.querySelectorAll('.sidebar-seccion').forEach(titulo => {
        let siguiente = titulo.nextElementSibling;
        let tieneModuloVisible = false;
        while (siguiente && !siguiente.classList.contains('sidebar-seccion')) {
            if (siguiente.classList.contains('nav-item') && !siguiente.hidden) tieneModuloVisible = true;
            siguiente = siguiente.nextElementSibling;
        }
        titulo.hidden = !tieneModuloVisible;
    });
    document.querySelectorAll('.modulo-admin').forEach(seccion => {
        seccion.hidden = !permitidos.has(seccion.id.replace('modulo-', ''));
        seccion.classList.remove('activo');
    });
    document.querySelectorAll('[data-dashboard-admin]').forEach(c => { c.hidden = rol !== 'Administrador'; });
    document.querySelectorAll('[data-dashboard-rol]').forEach(c => { c.hidden = c.dataset.dashboardRol !== rol; });
    cambiarModulo('dashboard', navegacion.querySelector('[data-modulo="dashboard"]'));
}

function limpiarPermisosSesion() {
    document.querySelector('.sidebar-subtitulo').textContent = 'Panel administrativo';
    document.getElementById('pedidosModuloSubtitulo').textContent = 'Prepara y entrega pedidos; la venta se genera al completar la entrega';
    document.querySelectorAll('.nav-item').forEach(boton => { boton.hidden = false; boton.classList.remove('activo'); });
    document.querySelectorAll('.sidebar-seccion').forEach(s => { s.hidden = false; });
    document.querySelectorAll('.modulo-admin').forEach(m => { m.hidden = false; m.classList.remove('activo'); });
    document.querySelectorAll('[data-dashboard-admin], [data-dashboard-rol]').forEach(c => { c.hidden = c.hasAttribute('data-dashboard-rol'); });
}

function cambiarModulo(modulo, boton) {
    if (!MODULOS_INFO[modulo]) return false;
    if (!puedeAccederModulo(modulo)) {
        alert('Acceso rechazado: tu rol no tiene permiso para abrir este módulo.');
        return false;
    }
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('activo'));
    const botonAutorizado = boton || document.querySelector(`[data-modulo="${modulo}"]`);
    if (!botonAutorizado || botonAutorizado.hidden || botonAutorizado.dataset.modulo !== modulo) return false;
    botonAutorizado.classList.add('activo');
    document.querySelectorAll('.modulo-admin').forEach(m => m.classList.remove('activo'));
    const moduloEl = document.getElementById('modulo-' + modulo);
    if (!moduloEl || moduloEl.hidden) return false;
    moduloEl.classList.add('activo');
    document.getElementById('adminTitulo').textContent = MODULOS_INFO[modulo][0];
    document.getElementById('adminSubtitulo').textContent = MODULOS_INFO[modulo][1];
    cerrarMenuLateral();
    if (modulo === 'reportes') cargarReporte();
    if (modulo === 'dashboard') actualizarDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
}

/* ------------------------- Menú lateral en móviles ------------------------- */

function alternarMenuLateral() {
    const abierto = !document.getElementById('sidebarAdmin').classList.contains('abierto');
    if (abierto) abrirMenuLateral();
    else cerrarMenuLateral();
}

function abrirMenuLateral() {
    document.getElementById('sidebarAdmin').classList.add('abierto');
    document.getElementById('sidebarFondo').classList.add('activo');
    const boton = document.getElementById('btnMenuLateral');
    boton.setAttribute('aria-expanded', 'true');
    boton.setAttribute('aria-label', 'Cerrar menú de navegación');
}

function cerrarMenuLateral() {
    document.getElementById('sidebarAdmin')?.classList.remove('abierto');
    document.getElementById('sidebarFondo')?.classList.remove('activo');
    const boton = document.getElementById('btnMenuLateral');
    if (boton) {
        boton.setAttribute('aria-expanded', 'false');
        boton.setAttribute('aria-label', 'Abrir menú de navegación');
    }
}

/* ===================================================================
   CARGA DE DATOS DEL PANEL (todo viene de PostgreSQL vía API)
   =================================================================== */

async function recargarPedidos() { Datos.pedidos = await api('/api/pedidos', { sesion: 'staff' }); }
async function recargarVentas() { if (puedeAccederModulo('ventas')) Datos.ventas = await api('/api/ventas', { sesion: 'staff' }); }
async function recargarClientes() { Datos.clientes = await api('/api/clientes', { sesion: 'staff' }); }
async function recargarIngredientes() { Datos.ingredientes = await api('/api/ingredientes', { sesion: 'staff' }); }
async function recargarMovimientos() { if (esAdministradorActual()) Datos.movimientos = await api('/api/inventario/movimientos', { sesion: 'staff', parametros: { limite: 300 } }); }
async function recargarProductosAdmin() { if (esAdministradorActual()) Datos.catalogoAdmin = await api('/api/productos', { sesion: 'staff', parametros: { todos: true } }); }
async function recargarPromocionesAdmin() { if (esAdministradorActual()) Datos.promocionesAdmin = await api('/api/promociones', { sesion: 'staff' }); }
async function recargarProveedores() { if (esAdministradorActual()) Datos.proveedores = await api('/api/proveedores', { sesion: 'staff' }); }
async function recargarUsuarios() { if (esAdministradorActual()) Datos.usuarios = await api('/api/usuarios', { sesion: 'staff' }); }
async function recargarPromocionesInternas() { Datos.promocionesInternas = await api('/api/promociones/vigentes', { sesion: 'staff' }); }

async function cargarDatosPanel() {
    const tareas = [
        ['pedidos', recargarPedidos], ['clientes', recargarClientes], ['inventario', recargarIngredientes],
        ['ventas', recargarVentas], ['catálogo', () => cargarCatalogo({ silencioso: true })],
        ['promociones', recargarPromocionesInternas], ['movimientos', recargarMovimientos],
        ['productos', recargarProductosAdmin], ['combos', recargarPromocionesAdmin],
        ['proveedores', recargarProveedores], ['usuarios', recargarUsuarios]
    ];
    const resultados = await Promise.allSettled(tareas.map(([, tarea]) => tarea()));
    const fallidos = resultados
        .map((r, i) => ({ r, etiqueta: tareas[i][0] }))
        .filter(({ r }) => r.status === 'rejected');
    fallidos.forEach(({ r, etiqueta }) => console.error(`No se pudo cargar ${etiqueta}:`, r.reason));
    if (fallidos.length) {
        mostrarNotificacion(`No se pudieron cargar: ${fallidos.map(f => f.etiqueta).join(', ')}. ${fallidos[0].r.reason?.message || ''}`, 'error');
    }
}

function renderizarTodoAdmin() {
    renderizarTablaPedidos();
    renderizarTablaClientes();
    if (puedeAccederModulo('ventas')) renderizarTablaVentas();
    renderizarTablaInventario();
    if (esAdministradorActual()) {
        renderizarTablaPedidosDashboard();
        renderizarTablaProductos();
        renderizarTablaPromociones();
        renderizarTablaProveedores();
        renderizarTablaUsuarios();
    }
    actualizarDashboard();
}

/** Actualización periódica de pedidos y ventas mientras el panel está abierto (ve pedidos web nuevos sin recargar). */
async function refrescarPanelPeriodicamente() {
    if (!usuarioActual || document.visibilityState !== 'visible') return;
    if (!document.getElementById('vistaAdmin').classList.contains('activa')) return;
    if (document.querySelector('.modal-overlay.activo')) return;
    try {
        await Promise.all([recargarPedidos(), recargarVentas(), recargarIngredientes()]);
        renderizarTablaPedidos();
        if (puedeAccederModulo('ventas')) renderizarTablaVentas();
        renderizarTablaInventario();
        if (esAdministradorActual()) renderizarTablaPedidosDashboard();
        actualizarDashboard();
    } catch (error) {
        console.error('No se pudo actualizar el panel:', error);
    }
}

async function actualizarPanelManual(boton) {
    if (boton) boton.disabled = true;
    try {
        await Promise.all([recargarPedidos(), recargarVentas(), recargarIngredientes(), cargarCatalogo({ silencioso: true })]);
        renderizarTodoAdmin();
        mostrarNotificacion('Datos actualizados desde la base de datos.');
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    } finally {
        if (boton) boton.disabled = false;
    }
}

/* ===================================================================
   PEDIDOS, VENTAS Y PAGOS
   =================================================================== */

function renderizarTablaPedidosDashboard() {
    const cuerpo = document.getElementById('tablaPedidosDashboard');
    if (!esAdministradorActual()) {
        cuerpo.replaceChildren();
        return;
    }
    const hoy = fechaLocalISO();
    const pedidosHoy = Datos.pedidos.filter(p => claveFechaLocal(p.fecha) === hoy).slice(0, 5);
    cuerpo.innerHTML = pedidosHoy.length ? pedidosHoy.map(p => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(p.codigo)}</td>
            <td>${escaparHTML(p.cliente)}</td>
            <td style="color: var(--gray-500);">${escaparHTML(formatearFechaComercial(p.fecha))}</td>
            <td style="font-weight: 600;">${formatearCOP(p.total)}</td>
            <td>${badgeEstado(p.estado)}</td>
        </tr>`).join('') : '<tr><td colspan="5" class="tabla-vacia">No hay pedidos registrados hoy.</td></tr>';
}

function accionesPedido(pedido) {
    const acciones = {
        Pendiente: [['Confirmado', 'Confirmar', 'accion-editar'], ['Cancelado', 'Cancelar', 'accion-eliminar']],
        Confirmado: [['En preparación', 'Iniciar preparación', 'accion-editar'], ['Cancelado', 'Cancelar', 'accion-eliminar']],
        'En preparación': [['Listo para entregar', 'Marcar listo', 'accion-editar'], ['Cancelado', 'Cancelar', 'accion-eliminar']],
        'Listo para entregar': [['Entregado', 'Entregar', 'accion-editar'], ['Cancelado', 'Cancelar', 'accion-eliminar']]
    }[pedido.estado] || [];
    return acciones.map(([estado, etiqueta, clase]) =>
        `<button class="accion-btn ${clase}" data-pedido="${pedido.id}" data-estado-pedido="${escaparHTML(estado)}">${etiqueta}</button>`).join('');
}

function renderizarTablaPedidos() {
    const tabla = document.getElementById('tablaPedidos');
    if (!puedeAccederModulo('pedidos')) {
        tabla.replaceChildren();
        return false;
    }
    const fechaFiltro = document.getElementById('filtroPedidosFecha')?.value || '';
    const textoFiltro = (document.getElementById('filtroPedidosCliente')?.value || '').trim().toLowerCase();
    const estadoFiltro = document.getElementById('filtroPedidosEstado')?.value || '';
    // La fecha del filtro es un día calendario local: se compara con la fecha local del pedido (no con UTC).
    const filtrados = Datos.pedidos.filter(p =>
        (!fechaFiltro || claveFechaLocal(p.fecha) === fechaFiltro)
        && (!textoFiltro || `${p.codigo} ${p.cliente} ${p.mesa || ''}`.toLowerCase().includes(textoFiltro))
        && (!estadoFiltro || p.estado === estadoFiltro));

    tabla.innerHTML = filtrados.length ? filtrados.map(p => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(p.codigo)}</td>
            <td>${escaparHTML(p.cliente)}</td>
            <td style="color: var(--gray-500);">${escaparHTML(formatearFechaComercial(p.fecha))}</td>
            <td>${escaparHTML(resumenProductos(p.productos))}</td>
            <td style="font-weight: 600;">${formatearCOP(p.total)}</td>
            <td>${escaparHTML(p.tipo || 'No definido')}${p.mesa ? `<div class="pedido-medio-pago">Mesa ${escaparHTML(p.mesa)}</div>` : ''}</td>
            <td>${badgeEstado(p.estado)}</td>
            <td>${badgeEstado(p.estadoPago || 'Pendiente')}${p.estadoPago === 'Pagado' && p.metodoPago ? `<div class="pedido-medio-pago">Medio: ${escaparHTML(p.metodoPago)}</div>` : ''}</td>
            <td>
                <div class="tabla-acciones">
                    <button class="accion-btn accion-ver" data-ver-pedido="${p.id}">Ver</button>
                    ${puedeAccederModulo('ventas') && p.estado !== 'Cancelado' && p.estadoPago !== 'Pagado' ? `<button class="accion-btn accion-editar" data-cobrar-pedido="${p.id}">Cobrar</button>` : ''}
                    ${accionesPedido(p)}
                </div>
            </td>
        </tr>`).join('') : '<tr><td colspan="9" class="tabla-vacia">No hay pedidos para los filtros seleccionados.</td></tr>';

    tabla.querySelectorAll('[data-ver-pedido]').forEach(b => b.addEventListener('click', () => mostrarDetalleComercial('pedido', Number(b.dataset.verPedido))));
    tabla.querySelectorAll('[data-cobrar-pedido]').forEach(b => b.addEventListener('click', () => abrirModalPago(Number(b.dataset.cobrarPedido))));
    tabla.querySelectorAll('[data-estado-pedido]').forEach(b => b.addEventListener('click', () => solicitarCambioEstado(Number(b.dataset.pedido), b.dataset.estadoPedido)));
    if (puedeAccederModulo('ventas')) renderizarTablaPedidosCobro();
}

function solicitarCambioEstado(id, nuevoEstado) {
    if (nuevoEstado === 'Cancelado') {
        pedirConfirmacionEntidad('Cancelar pedido', 'El pedido se cancelará y los ingredientes descontados volverán al inventario. ¿Continuar?', 'Sí, cancelar', () => cambiarEstadoPedido(id, nuevoEstado));
    } else {
        cambiarEstadoPedido(id, nuevoEstado);
    }
}

function reemplazarPedido(actualizado) {
    const indice = Datos.pedidos.findIndex(p => p.id === actualizado.id);
    if (indice >= 0) Datos.pedidos[indice] = actualizado;
    else Datos.pedidos.unshift(actualizado);
}

async function cambiarEstadoPedido(id, nuevoEstado) {
    if (!exigirModulo('pedidos', 'actualizar pedidos')) return false;
    try {
        const actualizado = await api(`/api/pedidos/${id}/estado`, { metodo: 'PATCH', sesion: 'staff', cuerpo: { estado: nuevoEstado } });
        reemplazarPedido(actualizado);
        if (nuevoEstado === 'Cancelado') {
            // La cancelación devuelve ingredientes: se refresca inventario, kardex y disponibilidad.
            await Promise.allSettled([recargarIngredientes(), recargarMovimientos(), cargarCatalogo({ silencioso: true })]);
            renderizarTablaInventario();
        }
        renderizarTablaPedidos();
        if (esAdministradorActual()) renderizarTablaPedidosDashboard();
        actualizarDashboard();
        return true;
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
        await recargarPedidos().catch(() => {});
        renderizarTablaPedidos();
        return false;
    }
}

/* ------------------------------ Ventas ------------------------------ */

function renderizarTablaVentas() {
    const tabla = document.getElementById('tablaVentas');
    if (!puedeAccederModulo('ventas')) {
        tabla.replaceChildren();
        document.getElementById('tablaPedidosCobro').replaceChildren();
        return false;
    }
    const fechaFiltro = document.getElementById('filtroVentasFecha')?.value || '';
    const textoFiltro = (document.getElementById('filtroVentasCliente')?.value || '').trim().toLowerCase();
    const estadoFiltro = document.getElementById('filtroVentasEstado')?.value || '';
    const filtradas = Datos.ventas.filter(v =>
        (!fechaFiltro || claveFechaLocal(v.fecha) === fechaFiltro)
        && (!textoFiltro || `${v.codigo} ${v.cliente}`.toLowerCase().includes(textoFiltro))
        && (!estadoFiltro || v.estado === estadoFiltro));

    tabla.innerHTML = filtradas.length ? filtradas.map(v => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(v.codigo)}</td>
            <td>${escaparHTML(formatearFechaComercial(v.fecha))}</td>
            <td>${escaparHTML(v.cliente)}</td>
            <td>${escaparHTML(resumenProductos(v.productos))}</td>
            <td>${cantidadProductos(v.productos)}</td>
            <td style="font-weight: 600;">${formatearCOP(v.total)}</td>
            <td>${escaparHTML(v.metodoPago || 'No registrado')}</td>
            <td>${badgeEstado(v.estado)}</td>
            <td><button class="accion-btn accion-ver" data-ver-venta="${v.id}">Ver</button></td>
        </tr>`).join('') : '<tr><td colspan="9" class="tabla-vacia">No hay ventas completadas para los filtros seleccionados.</td></tr>';
    tabla.querySelectorAll('[data-ver-venta]').forEach(b => b.addEventListener('click', () => mostrarDetalleComercial('venta', Number(b.dataset.verVenta))));
    renderizarTablaPedidosCobro();
    actualizarIndicadoresVentas();
}

function renderizarTablaPedidosCobro() {
    const tabla = document.getElementById('tablaPedidosCobro');
    if (!puedeAccederModulo('ventas')) {
        tabla.replaceChildren();
        return false;
    }
    const pendientes = Datos.pedidos.filter(p => p.estadoPago !== 'Pagado' && p.estado !== 'Cancelado');
    tabla.innerHTML = pendientes.length ? pendientes.map(p => `
        <tr>
            <td>${escaparHTML(p.codigo)}</td>
            <td>${escaparHTML(p.cliente)}</td>
            <td>${escaparHTML(p.tipo || 'No definido')}</td>
            <td>${formatearCOP(p.total)}</td>
            <td>${badgeEstado(p.estado)}</td>
            <td><button class="accion-btn accion-editar" data-cobrar-pedido="${p.id}">Cobrar</button></td>
        </tr>`).join('') : '<tr><td colspan="6" class="tabla-vacia">No hay pedidos pendientes de cobro.</td></tr>';
    tabla.querySelectorAll('[data-cobrar-pedido]').forEach(b => b.addEventListener('click', () => abrirModalPago(Number(b.dataset.cobrarPedido))));
    return true;
}

function actualizarIndicadoresVentas() {
    const hoy = fechaLocalISO();
    const ventasHoy = Datos.ventas.filter(v => claveFechaLocal(v.fecha) === hoy);
    const total = ventasHoy.reduce((s, v) => s + Number(v.total || 0), 0);
    document.getElementById('ventasCantidadHoy').textContent = String(ventasHoy.length);
    document.getElementById('ventasTotalHoy').textContent = formatearCOP(total);
    document.getElementById('ventasProductosHoy').textContent = String(ventasHoy.reduce((s, v) => s + cantidadProductos(v.productos), 0));
    document.getElementById('ventasTicketPromedio').textContent = formatearCOP(ventasHoy.length ? total / ventasHoy.length : 0);
}

function mostrarDetalleComercial(tipo, id) {
    if (!exigirModulo(tipo === 'venta' ? 'ventas' : 'pedidos', 'consultar este detalle')) return false;
    const registro = tipo === 'venta' ? Datos.ventas.find(v => v.id === id) : Datos.pedidos.find(p => p.id === id);
    if (!registro) {
        mostrarNotificacion('No se encontró el registro. Actualiza los datos e inténtalo de nuevo.', 'error');
        return false;
    }
    const esPedido = tipo === 'pedido';
    const pedido = esPedido ? registro : (Datos.pedidos.find(p => p.id === registro.pedidoId) || {});
    document.getElementById('tituloDetalleComercial').textContent = `${esPedido ? 'Pedido' : 'Venta'} ${registro.codigo}`;
    const campo = (etiqueta, valor) => valor ? `<div><span>${etiqueta}</span><strong>${escaparHTML(valor)}</strong></div>` : '';
    document.getElementById('contenidoDetalleComercial').innerHTML = `
        <div class="detalle-comercial-resumen">
            <div><span>Código</span><strong>${escaparHTML(registro.codigo)}</strong></div>
            <div><span>Fecha y hora</span><strong>${escaparHTML(formatearFechaComercial(registro.fecha))}</strong></div>
            <div><span>Cliente</span><strong>${escaparHTML(registro.cliente || 'Sin cliente registrado')}</strong></div>
            <div><span>Correo</span><strong>${escaparHTML(registro.clienteCorreo || 'No disponible')}</strong></div>
            ${esPedido ? '' : `<div><span>Pedido relacionado</span><strong>${escaparHTML(registro.pedidoCodigo)}</strong></div>`}
            ${campo('Tipo de pedido', esPedido ? registro.tipo : registro.tipo)}
            ${campo('Mesa', pedido.mesa)}
            ${campo('Canal', pedido.canal)}
            ${campo('Dirección', pedido.direccionEntrega)}
            ${campo('Quien recibe', pedido.nombreRecibe)}
            ${campo('Teléfono de contacto', pedido.telefonoEntrega)}
            ${campo('Barrio', pedido.barrioEntrega)}
            ${campo('Indicaciones de entrega', pedido.indicacionesEntrega)}
            ${campo('Observaciones', pedido.observaciones)}
            <div><span>Estado</span><strong>${badgeEstado(esPedido ? registro.estado : registro.estado)}</strong></div>
            <div><span>Estado del pago</span><strong>${badgeEstado(esPedido ? (registro.estadoPago || 'Pendiente') : 'Pagado')}</strong></div>
            <div><span>Método de pago</span><strong>${escaparHTML(registro.metodoPago || 'No registrado')}</strong></div>
            ${esPedido && registro.medioPagoSolicitado && registro.estadoPago !== 'Pagado' ? campo('Medio elegido (pago pendiente)', registro.medioPagoSolicitado) : ''}
        </div>
        <div class="tabla-wrapper detalle-comercial-tabla"><table class="tabla"><thead><tr><th>Producto</th><th>Cantidad</th><th>Precio unitario</th><th>Subtotal</th></tr></thead><tbody>
            ${(registro.productos || []).map(l => `<tr><td>${escaparHTML(l.nombre)}${l.tamano ? ` · ${escaparHTML(l.tamano)}` : ''}${l.descuentoUnitario ? `<small class="detalle-componentes">Combo con descuento de ${escaparHTML(formatearCOP(l.descuentoUnitario))} por unidad</small>` : ''}</td><td>${Number(l.cantidad || 0)}</td><td>${formatearCOP(l.precioUnitario)}</td><td>${formatearCOP(l.precioUnitario * l.cantidad)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="detalle-comercial-totales">
            <div><span>Subtotal</span><strong>${formatearCOPConDecimales(registro.subtotal)}</strong></div>
            <div><span>Descuentos</span><strong>− ${formatearCOPConDecimales(registro.descuento)}</strong></div>
            <div><span>IVA (16%)</span><strong>${formatearCOPConDecimales(registro.iva)}</strong></div>
            <div class="detalle-total"><span>Total ${(esPedido ? registro.estadoPago : 'Pagado') === 'Pagado' ? 'pagado' : 'del pedido'}</span><strong>${formatearCOPConDecimales(registro.total)}</strong></div>
        </div>`;
    document.getElementById('modalDetalleComercial').classList.add('activo');
    return true;
}

/* ------------------------------ Pagos ------------------------------ */

function abrirModalPago(pedidoId) {
    if (!exigirModulo('ventas', 'registrar pagos')) return false;
    const pedido = Datos.pedidos.find(p => p.id === pedidoId);
    if (!pedido || pedido.estado === 'Cancelado' || pedido.estadoPago === 'Pagado') {
        mostrarNotificacion('Este pedido no está disponible para cobro.', 'error');
        return false;
    }
    pedidoPagoSeleccionadoId = pedido.id;
    document.getElementById('resumenPagoPedido').textContent = `${pedido.codigo} · ${pedido.cliente} · Total: ${formatearCOPConDecimales(pedido.total)}`;
    if (pedido.medioPagoSolicitado) document.getElementById('medioPagoPedido').value = pedido.medioPagoSolicitado;
    document.getElementById('modalPago').classList.add('activo');
    return true;
}

function cerrarModalPago() {
    pedidoPagoSeleccionadoId = null;
    cerrarModal('modalPago');
}

function registrarPagoPedido(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirModulo('ventas', 'registrar pagos') || pedidoPagoSeleccionadoId === null) return false;
        try {
            const actualizado = await api(`/api/pedidos/${pedidoPagoSeleccionadoId}/pago`, {
                metodo: 'POST', sesion: 'staff',
                cuerpo: { medioPago: document.getElementById('medioPagoPedido').value }
            });
            reemplazarPedido(actualizado);
            cerrarModalPago();
            await recargarVentas();
            renderizarTablaPedidos();
            renderizarTablaVentas();
            if (esAdministradorActual()) renderizarTablaPedidosDashboard();
            actualizarDashboard();
            mostrarNotificacion('Pago registrado y venta guardada en PostgreSQL.');
            return true;
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
            await recargarPedidos().catch(() => {});
            renderizarTablaPedidos();
            return false;
        }
    });
}

/* ===================================================================
   DASHBOARD
   =================================================================== */

function estadoInventario(item) {
    if (item.activo === false) return 'Inactivo';
    if (item.cantidad <= 0) return 'Agotado';
    if (item.cantidad <= item.minimo) return 'Stock bajo';
    return 'Disponible';
}

function ventasProductosMasVendidos(ventas) {
    const cantidades = new Map();
    for (const venta of ventas) {
        for (const l of venta.productos || []) {
            const clave = `${l.productoId ?? 'c' + l.promocionId}-${l.tamano || ''}`;
            const actual = cantidades.get(clave) || { nombre: l.nombre, tamano: l.tamano || '', cantidad: 0 };
            actual.cantidad += Number(l.cantidad || 0);
            cantidades.set(clave, actual);
        }
    }
    return [...cantidades.values()].sort((a, b) => b.cantidad - a.cantidad);
}

function actualizarDashboard() {
    if (!usuarioActual) return;
    if (!esAdministradorActual()) {
        actualizarDashboardOperativo();
        return;
    }
    const hoy = fechaLocalISO();
    const ventasHoy = Datos.ventas.filter(v => claveFechaLocal(v.fecha) === hoy);
    const pendientes = Datos.pedidos.filter(p => ['Pendiente', 'Confirmado'].includes(p.estado)).length;
    const preparacion = Datos.pedidos.filter(p => ['En preparación', 'Listo para entregar'].includes(p.estado)).length;
    document.getElementById('dashboardVentasHoy').textContent = formatearCOP(ventasHoy.reduce((t, v) => t + Number(v.total || 0), 0));
    document.getElementById('dashboardCantidadVentas').textContent = String(Datos.ventas.length);
    document.getElementById('dashboardPedidosActivos').textContent = `${pendientes} / ${preparacion}`;
    document.getElementById('dashboardClientes').textContent = String(Datos.clientes.filter(c => c.activo !== false).length);
    document.getElementById('dashboardInventarioBajo').textContent = String(Datos.ingredientes.filter(i => i.activo && i.cantidad <= i.minimo).length);

    const dias = Number(document.getElementById('dashboardPeriodoVentas')?.value || 7);
    const inicio = new Date();
    inicio.setDate(inicio.getDate() - (dias - 1));
    const desde = fechaLocalISO(inicio);
    const ventasPeriodo = Datos.ventas.filter(v => {
        const dia = claveFechaLocal(v.fecha);
        return dia >= desde && dia <= hoy;
    });
    renderizarResumenMasVendidos(Datos.ventas, 'dashboardProductosMasVendidos', 'Aún no hay ventas para calcular productos más vendidos.');
    actualizarGraficoVentas('chartVentasSemana', 'dashboardVentasVacio', ventasPeriodo.map(v => ({ fecha: v.fecha, total: v.total })), dias);
    actualizarDashboardOperativo();
}

function renderizarResumenMasVendidos(ventas, contenedorId, vacio) {
    const contenedor = document.getElementById(contenedorId);
    if (!contenedor || !esAdministradorActual()) return;
    const productos = ventasProductosMasVendidos(ventas).slice(0, 5);
    contenedor.innerHTML = productos.length
        ? `<h4>Productos más vendidos</h4><ol>${productos.map(i => `<li>${escaparHTML(i.nombre)}${i.tamano ? ` · ${escaparHTML(i.tamano)}` : ''}<strong>${i.cantidad}</strong></li>`).join('')}</ol>`
        : `<p class="reporte-nota">${escaparHTML(vacio)}</p>`;
}

function actualizarGraficoVentas(canvasId, vacioId, registros, maxTicks = 10) {
    const canvas = document.getElementById(canvasId);
    const vacio = document.getElementById(vacioId);
    if (!canvas) return;
    if (typeof Chart === 'undefined') {
        canvas.hidden = true;
        if (vacio) {
            vacio.textContent = 'No se pudo cargar la herramienta de gráficos.';
            vacio.hidden = false;
        }
        return;
    }
    if (canvas._chart) {
        canvas._chart.destroy();
        canvas._chart = null;
    }
    if (!registros.length) {
        canvas.hidden = true;
        if (vacio) vacio.hidden = false;
        return;
    }
    canvas.hidden = false;
    if (vacio) vacio.hidden = true;
    const totales = new Map();
    registros.forEach(r => {
        const dia = claveFechaLocal(r.fecha);
        totales.set(dia, (totales.get(dia) || 0) + Number(r.total || 0));
    });
    const etiquetas = [...totales.keys()].sort();
    canvas._chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: etiquetas,
            datasets: [{ label: 'Ingresos', data: etiquetas.map(d => totales.get(d)), backgroundColor: 'rgba(216,30,24, 0.82)', borderColor: '#D81E18', borderRadius: 7, borderSkipped: false }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, grid: { color: '#F4F4F4' } }, x: { grid: { display: false }, ticks: { maxTicksLimit: maxTicks } } }
        }
    });
}

function obtenerResumenMesas() {
    const mesas = new Map();
    Datos.pedidos
        .filter(p => p.tipo === 'Mesa' && String(p.mesa || '').trim())
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
        .forEach(pedido => {
            const mesa = String(pedido.mesa).trim();
            const clave = mesa.toLocaleLowerCase('es-CO');
            if (!mesas.has(clave)) mesas.set(clave, { mesa, pedido: null });
            const activa = pedido.estado !== 'Cancelado' && !(pedido.estado === 'Entregado' && pedido.estadoPago === 'Pagado');
            if (activa && !mesas.get(clave).pedido) mesas.get(clave).pedido = pedido;
        });
    return [...mesas.values()].sort((a, b) => a.mesa.localeCompare(b.mesa, 'es-CO', { numeric: true, sensitivity: 'base' }));
}

function renderizarMesasActivas() {
    const contenedor = document.getElementById('meseraMesasGrid');
    const mesas = obtenerResumenMesas();
    document.getElementById('meseraMesasActivas').textContent = String(mesas.filter(m => m.pedido).length);
    contenedor.innerHTML = mesas.length ? mesas.map(({ mesa, pedido }) => {
        if (!pedido) {
            return `<article class="mesa-activa-card mesa-libre"><div class="mesa-activa-cabecera"><h4>Mesa ${escaparHTML(mesa)}</h4><span class="mesa-estado">Libre</span></div><p>Disponible para un nuevo cliente.</p></article>`;
        }
        const pendientePago = pedido.estado === 'Entregado' && pedido.estadoPago !== 'Pagado';
        return `<article class="mesa-activa-card ${pendientePago ? 'mesa-pendiente-pago' : 'mesa-ocupada'}">
            <div class="mesa-activa-cabecera"><h4>Mesa ${escaparHTML(mesa)}</h4><span class="mesa-estado">${pendientePago ? 'Pendiente de pago' : 'Ocupada'}</span></div>
            <p><strong>Pedido:</strong> ${escaparHTML(pedido.codigo)}</p>
            <p><strong>Estado:</strong> ${escaparHTML(pedido.estado)}</p>
            <p><strong>Cliente:</strong> ${escaparHTML(pedido.cliente || 'Cliente mostrador')}</p>
        </article>`;
    }).join('') : '<p class="mesas-sin-registros">Aún no se han registrado mesas. Al recibir un cliente, crea un pedido de tipo Mesa para comenzar.</p>';
}

function actualizarDashboardOperativo() {
    const hoy = fechaLocalISO();
    const ventasHoy = Datos.ventas.filter(v => claveFechaLocal(v.fecha) === hoy);
    const sinPago = Datos.pedidos.filter(p => p.estadoPago !== 'Pagado' && p.estado !== 'Cancelado');
    const abiertos = Datos.pedidos.filter(p => !['Entregado', 'Cancelado'].includes(p.estado));
    const contar = estados => Datos.pedidos.filter(p => estados.includes(p.estado)).length;

    document.getElementById('cajeraVentasHoy').textContent = formatearCOP(ventasHoy.reduce((t, v) => t + Number(v.total || 0), 0));
    document.getElementById('cajeraPendientesCobro').textContent = String(sinPago.length);
    document.getElementById('cajeraPedidosAbiertos').textContent = String(abiertos.length);
    const medios = new Map();
    Datos.ventas.forEach(v => medios.set(v.metodoPago || 'No especificado', (medios.get(v.metodoPago || 'No especificado') || 0) + 1));
    document.getElementById('cajeraMediosPago').innerHTML = medios.size
        ? [...medios].map(([medio, cantidad]) => `<p>${escaparHTML(medio)}: <strong>${cantidad}</strong></p>`).join('')
        : '<p>No hay pagos registrados.</p>';

    const agotados = Datos.ingredientes.filter(i => i.activo && estadoInventario(i) === 'Agotado');
    const resumen = agotados.length
        ? `<ul>${agotados.map(i => `<li>${escaparHTML(i.nombre)}</li>`).join('')}</ul>`
        : '<p>No hay productos o ingredientes marcados como agotados.</p>';
    document.getElementById('cajeraDisponibilidad').innerHTML = resumen;
    document.getElementById('meseraDisponibilidad').innerHTML = resumen;
    document.getElementById('meseraPedidosPendientes').textContent = String(contar(['Pendiente', 'Confirmado']));
    document.getElementById('meseraPedidosPreparacion').textContent = String(contar(['En preparación']));
    document.getElementById('meseraPedidosListos').textContent = String(contar(['Listo para entregar']));
    renderizarMesasActivas();
}

/* ===================================================================
   INVENTARIO: ingredientes, recetas y movimientos
   =================================================================== */

function renderizarTablaInventario() {
    if (!esAdministradorActual()) {
        ['tablaInventario', 'inventarioAlertas', 'tablaMovimientos'].forEach(id => document.getElementById(id).replaceChildren());
        actualizarDashboardOperativo();
        return false;
    }
    const ingredientes = Datos.ingredientes;
    document.getElementById('tablaInventario').innerHTML = ingredientes.length ? ingredientes.map(i => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(i.nombre)}${i.proveedor ? `<small class="detalle-componentes">${escaparHTML(i.proveedor)}</small>` : ''}</td>
            <td>${escaparHTML(i.categoria || 'Otros')}</td>
            <td>${formatearCantidad(i.cantidad)} ${escaparHTML(i.unidad)}</td>
            <td><label class="stock-minimo-control"><input type="number" min="0" step="0.001" value="${i.minimo}" onchange="actualizarStockMinimo(${i.id}, this.value)" aria-label="Stock mínimo de ${escaparHTML(i.nombre)}"><span>${escaparHTML(i.unidad)}</span></label></td>
            <td style="color: var(--gray-500);">${escaparHTML(formatearFechaComercial(i.fechaActualizacion))}</td>
            <td>${badgeEstado(estadoInventario(i))}</td>
            <td><div class="tabla-acciones">
                <button class="accion-btn accion-editar" onclick="abrirFormularioIngrediente(${i.id})">Editar</button>
                <button class="accion-btn ${i.activo ? 'accion-eliminar' : 'accion-editar'}" onclick="${i.activo ? `eliminarIngrediente(${i.id})` : `reactivarIngrediente(${i.id})`}">${i.activo ? 'Eliminar' : 'Activar'}</button>
            </div></td>
        </tr>`).join('') : '<tr><td colspan="7" class="tabla-vacia">Aún no hay ingredientes registrados.</td></tr>';

    const criticos = ingredientes.filter(i => i.activo && i.cantidad <= i.minimo);
    document.getElementById('inventarioAlertas').innerHTML = criticos.length
        ? `<div class="alerta-inventario"><strong>⚠ ${criticos.length} producto(s) requieren atención</strong><span>${criticos.map(i => `${escaparHTML(i.nombre)}: ${formatearCantidad(i.cantidad)} ${escaparHTML(i.unidad)}${i.cantidad <= 0 ? ' (agotado)' : ''}`).join(' · ')}</span></div>`
        : '<div class="alerta-inventario alerta-inventario-ok">✓ Todo el inventario está sobre su stock mínimo.</div>';
    renderizarOpcionesInventario();
    renderizarTablaMovimientos();
    actualizarDashboardOperativo();
}

function cuerpoIngrediente(ingrediente, cambios = {}) {
    return {
        nombre: ingrediente.nombre, categoria: ingrediente.categoria, unidad: ingrediente.unidad,
        minimo: ingrediente.minimo, costoUnidad: ingrediente.costoUnidad, proveedorId: ingrediente.proveedorId,
        vencimiento: ingrediente.vencimiento, observaciones: ingrediente.observaciones, activo: ingrediente.activo,
        ...cambios
    };
}

async function actualizarStockMinimo(id, valor) {
    if (!exigirAdministrador('modificar el inventario')) return;
    const minimo = Number(valor);
    const ingrediente = Datos.ingredientes.find(i => i.id === id);
    if (!ingrediente || !Number.isFinite(minimo) || minimo < 0) {
        renderizarTablaInventario();
        return;
    }
    try {
        // No se envía "cantidad": el stock solo cambia por movimientos, pedidos o ajustes explícitos.
        await api(`/api/ingredientes/${id}`, { metodo: 'PUT', sesion: 'staff', cuerpo: cuerpoIngrediente(ingrediente, { minimo }) });
        await recargarIngredientes();
        mostrarNotificacion('Stock mínimo actualizado.');
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
    renderizarTablaInventario();
}

function abrirFormularioIngrediente(id = null) {
    if (!exigirAdministrador('administrar el inventario')) return;
    const ingrediente = id === null ? null : Datos.ingredientes.find(i => i.id === id);
    if (id !== null && !ingrediente) return;
    document.getElementById('formularioIngrediente').reset();
    const error = document.getElementById('errorFormularioIngrediente');
    error.hidden = true;
    error.textContent = '';
    document.getElementById('ingredienteIdEdicion').value = ingrediente?.id ?? '';
    document.getElementById('tituloModalIngrediente').textContent = ingrediente ? 'Editar ingrediente' : 'Nuevo ingrediente';
    document.getElementById('ingredienteNombre').value = ingrediente?.nombre || '';
    document.getElementById('ingredienteCategoria').value = ingrediente?.categoria || 'Otros';
    const cantidad = document.getElementById('ingredienteCantidad');
    cantidad.value = ingrediente?.cantidad ?? 0;
    cantidad.dataset.original = String(ingrediente?.cantidad ?? 0);
    const unidad = document.getElementById('ingredienteUnidad');
    if (ingrediente && ![...unidad.options].some(o => o.value === ingrediente.unidad)) unidad.add(new Option(ingrediente.unidad, ingrediente.unidad));
    unidad.value = ingrediente?.unidad || 'kg';
    document.getElementById('ingredienteMinimo').value = ingrediente?.minimo ?? 0;
    document.getElementById('ingredienteCosto').value = ingrediente?.costoUnidad ?? 0;
    document.getElementById('ingredienteVencimiento').value = ingrediente?.vencimiento || '';
    document.getElementById('ingredienteObservaciones').value = ingrediente?.observaciones || '';
    const proveedores = document.getElementById('ingredienteProveedor');
    proveedores.innerHTML = '<option value="">Sin proveedor</option>' + Datos.proveedores
        .filter(p => p.activo || p.id === ingrediente?.proveedorId)
        .map(p => `<option value="${p.id}">${escaparHTML(p.nombre)}</option>`).join('');
    proveedores.value = ingrediente?.proveedorId ?? '';
    document.getElementById('modalIngrediente').classList.add('activo');
}

function cerrarModalIngrediente() {
    cerrarModal('modalIngrediente');
    document.getElementById('formularioIngrediente').reset();
}

function guardarIngrediente(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('guardar cambios de inventario')) return;
        const error = document.getElementById('errorFormularioIngrediente');
        error.hidden = true;
        const id = document.getElementById('ingredienteIdEdicion').value;
        const campoCantidad = document.getElementById('ingredienteCantidad');
        const cantidad = Number(campoCantidad.value);
        const minimo = Number(document.getElementById('ingredienteMinimo').value);
        const costo = Number(document.getElementById('ingredienteCosto').value || 0);
        const nombre = document.getElementById('ingredienteNombre').value.trim();
        if (!nombre || !Number.isFinite(cantidad) || cantidad < 0 || !Number.isFinite(minimo) || minimo < 0 || !Number.isFinite(costo) || costo < 0) {
            error.textContent = 'Completa los campos obligatorios con cantidades y costos iguales o mayores que cero.';
            error.hidden = false;
            return;
        }
        const cuerpo = {
            nombre,
            categoria: document.getElementById('ingredienteCategoria').value,
            unidad: document.getElementById('ingredienteUnidad').value,
            minimo,
            costoUnidad: costo,
            proveedorId: Number(document.getElementById('ingredienteProveedor').value) || null,
            vencimiento: document.getElementById('ingredienteVencimiento').value || null,
            observaciones: document.getElementById('ingredienteObservaciones').value.trim()
        };
        // En una edición solo se envía la existencia si la persona la cambió (evita pisar descuentos recientes de pedidos).
        if (!id || String(cantidad) !== campoCantidad.dataset.original) cuerpo.cantidad = cantidad;
        try {
            await api(id ? `/api/ingredientes/${id}` : '/api/ingredientes', { metodo: id ? 'PUT' : 'POST', sesion: 'staff', cuerpo });
            cerrarModalIngrediente();
            await Promise.all([recargarIngredientes(), recargarMovimientos(), cargarCatalogo({ silencioso: true })]);
            renderizarTablaInventario();
            mostrarNotificacion(id ? 'Ingrediente actualizado.' : 'Ingrediente agregado al inventario.');
        } catch (errorApi) {
            error.textContent = errorApi.message;
            error.hidden = false;
        }
    });
}

function eliminarIngrediente(id) {
    if (!exigirAdministrador('eliminar ingredientes')) return;
    const ingrediente = Datos.ingredientes.find(i => i.id === id);
    if (!ingrediente) return;
    pedirConfirmacionEntidad('Eliminar ingrediente', `¿Estás segura de que deseas eliminar ${ingrediente.nombre}? Si tiene recetas o movimientos de pedidos solo se marcará como inactivo.`, 'Sí, eliminar', async () => {
        try {
            const respuesta = await api(`/api/ingredientes/${id}`, { metodo: 'DELETE', sesion: 'staff' });
            await Promise.all([recargarIngredientes(), recargarMovimientos(), cargarCatalogo({ silencioso: true })]);
            renderizarTablaInventario();
            mostrarNotificacion(respuesta.mensaje);
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
        }
    });
}

async function reactivarIngrediente(id) {
    if (!exigirAdministrador('reactivar ingredientes')) return;
    try {
        await api(`/api/ingredientes/${id}/estado`, { metodo: 'PATCH', sesion: 'staff', cuerpo: { activa: true } });
        await Promise.all([recargarIngredientes(), cargarCatalogo({ silencioso: true })]);
        renderizarTablaInventario();
        mostrarNotificacion('Ingrediente reactivado.');
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
}

function renderizarOpcionesInventario() {
    if (!esAdministradorActual()) return;
    const ingredienteSeleccionado = document.getElementById('movimientoIngrediente').value;
    document.getElementById('movimientoIngrediente').innerHTML = Datos.ingredientes.filter(i => i.activo)
        .map(i => `<option value="${i.id}">${escaparHTML(i.nombre)} (${escaparHTML(i.unidad)})</option>`).join('');
    if (ingredienteSeleccionado) document.getElementById('movimientoIngrediente').value = ingredienteSeleccionado;
    const selectorSabor = document.getElementById('recetaSabor');
    const saborPrevio = selectorSabor.value;
    selectorSabor.innerHTML = Datos.catalogoAdmin.filter(p => p.categoria === 'Pizzas')
        .map(p => `<option value="${p.id}">${escaparHTML(p.nombre.replace('Pizza ', ''))}</option>`).join('');
    if (saborPrevio) selectorSabor.value = saborPrevio;
    renderizarEditorReceta();
}

function renderizarEditorReceta() {
    if (!esAdministradorActual()) return;
    const selectorSabor = document.getElementById('recetaSabor');
    const editor = document.getElementById('editorReceta');
    if (!selectorSabor.value) {
        editor.innerHTML = '<p class="estado-carga">No hay pizzas en el catálogo.</p>';
        return;
    }
    const producto = Datos.catalogoAdmin.find(p => p.id === Number(selectorSabor.value));
    const tamano = document.getElementById('recetaTamano').value;
    const actual = new Map((producto?.recetas?.find(r => r.tamano === tamano)?.ingredientes || []).map(i => [i.ingredienteId, i.cantidad]));
    editor.innerHTML = Datos.ingredientes.filter(i => i.activo).map(i => `
        <label class="receta-fila">
            <span>${escaparHTML(i.nombre)}<small>${escaparHTML(i.unidad)}</small></span>
            <input type="number" min="0" step="0.001" value="${actual.get(i.id) || 0}" data-receta-ingrediente="${i.id}" aria-label="Cantidad de ${escaparHTML(i.nombre)}">
        </label>`).join('');
}

async function guardarReceta() {
    if (!exigirAdministrador('modificar recetas')) return;
    const productoId = Number(document.getElementById('recetaSabor').value);
    const tamano = document.getElementById('recetaTamano').value;
    const ingredientes = [];
    document.querySelectorAll('[data-receta-ingrediente]').forEach(input => {
        const cantidad = Number(input.value);
        if (Number.isFinite(cantidad) && cantidad > 0) ingredientes.push({ ingredienteId: Number(input.dataset.recetaIngrediente), cantidad });
    });
    if (!ingredientes.length) {
        alert('La receta debe incluir al menos un ingrediente.');
        return;
    }
    try {
        const actualizado = await api(`/api/productos/${productoId}/recetas`, { metodo: 'PUT', sesion: 'staff', cuerpo: { tamano, ingredientes } });
        const indice = Datos.catalogoAdmin.findIndex(p => p.id === productoId);
        if (indice >= 0) Datos.catalogoAdmin[indice] = actualizado;
        await cargarCatalogo({ silencioso: true });
        renderizarEditorReceta();
        mostrarNotificacion(`Receta ${tamano} guardada en PostgreSQL.`);
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
}

function renderizarTablaMovimientos() {
    const tabla = document.getElementById('tablaMovimientos');
    if (!esAdministradorActual()) {
        tabla.replaceChildren();
        return false;
    }
    tabla.innerHTML = Datos.movimientos.length ? Datos.movimientos.map(m => {
        const signo = m.tipo === 'Entrada' ? '+' : m.tipo === 'Salida' ? '−' : (m.cantidad >= 0 ? '+' : '−');
        return `<tr><td>${escaparHTML(formatearFechaComercial(m.fecha))}</td><td>${escaparHTML(m.ingrediente)}</td><td>${badgeEstado(m.tipo)}</td><td>${signo}${formatearCantidad(Math.abs(m.cantidad))} ${escaparHTML(m.unidad)}</td><td>${escaparHTML(m.motivo)}</td><td>${escaparHTML(m.pedidoCodigo || '—')}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="tabla-vacia">Aún no hay movimientos registrados.</td></tr>';
}

function actualizarEtiquetaMovimiento() {
    const esAjuste = document.getElementById('movimientoTipo').value === 'Ajuste';
    document.getElementById('movimientoEtiquetaCantidad').textContent = esAjuste ? 'Nueva existencia' : 'Cantidad';
}

function registrarMovimientoManual(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('registrar movimientos de inventario')) return;
        const tipo = document.getElementById('movimientoTipo').value;
        const cantidad = Number(document.getElementById('movimientoCantidad').value);
        if (!Number.isFinite(cantidad) || cantidad < 0 || (tipo !== 'Ajuste' && cantidad === 0)) {
            alert('La cantidad debe ser mayor que cero.');
            return;
        }
        try {
            await api('/api/inventario/movimientos', {
                metodo: 'POST', sesion: 'staff',
                cuerpo: { ingredienteId: Number(document.getElementById('movimientoIngrediente').value), tipo, cantidad, motivo: `${tipo} manual` }
            });
            evento.target.reset();
            actualizarEtiquetaMovimiento();
            await Promise.all([recargarIngredientes(), recargarMovimientos(), cargarCatalogo({ silencioso: true })]);
            renderizarTablaInventario();
            mostrarNotificacion('Movimiento registrado en el inventario.');
        } catch (error) {
            alert(error.message);
        }
    });
}

/* ===================================================================
   PRODUCTOS Y RECETAS
   =================================================================== */

function renderizarTablaProductos() {
    const tabla = document.getElementById('tablaProductos');
    if (!esAdministradorActual()) {
        tabla.replaceChildren();
        return false;
    }
    tabla.innerHTML = Datos.catalogoAdmin.length ? Datos.catalogoAdmin.map(p => `
        <tr>
            <td><div style="display: flex; align-items: center; gap: 10px;">
                ${p.imagen ? imagenHTML(p.imagen, p.nombre, 'tabla-imagen-producto') : `<span style="font-size: 22px;">${escaparHTML(p.emoji || '🍕')}</span>`}
                <span style="font-weight: 600;">${escaparHTML(p.nombre)}</span>
            </div></td>
            <td style="color: var(--gray-500); font-size: 12px;">${escaparHTML(p.descripcion || '')}</td>
            <td style="font-weight: 700; color: var(--brand-600);">${p.categoria === 'Pizzas'
                ? `<small>P</small> ${formatearCOP(p.precio)}<br><small>M</small> ${formatearCOP(p.precioMediana)}<br><small>F</small> ${formatearCOP(p.precioFamiliar)}`
                : formatearCOP(p.precio)}</td>
            <td>${escaparHTML(p.categoria)}${p.presentacion ? ` · ${escaparHTML(p.presentacion)}` : ''}</td>
            <td>${badgeEstado(p.disponible ? 'Disponible' : 'Inactivo')}</td>
            <td><div class="tabla-acciones">
                <button class="accion-btn accion-editar" onclick="abrirFormularioProducto(${p.id})">Editar</button>
                <button class="accion-btn accion-eliminar" onclick="eliminarProducto(${p.id})">Eliminar</button>
            </div></td>
        </tr>`).join('') : '<tr><td colspan="6" class="tabla-vacia">Aún no hay productos en el catálogo.</td></tr>';
}

function abrirFormularioProducto(id = null) {
    if (!exigirAdministrador('administrar productos')) return;
    const producto = id === null ? null : Datos.catalogoAdmin.find(p => p.id === id);
    if (id !== null && !producto) return;
    document.getElementById('formularioProducto').reset();
    document.getElementById('errorFormularioProducto').hidden = true;
    document.getElementById('productoIdEdicion').value = producto?.id ?? '';
    document.getElementById('tituloModalProducto').textContent = producto ? 'Editar producto' : 'Nuevo producto';
    document.getElementById('productoNombre').value = producto?.nombre || '';
    document.getElementById('productoCategoria').value = producto?.categoria || 'Pizzas';
    document.getElementById('productoPrecio').value = producto?.precio ?? '';
    document.getElementById('productoPrecioMediana').value = producto?.precioMediana ?? '';
    document.getElementById('productoPrecioFamiliar').value = producto?.precioFamiliar ?? '';
    document.getElementById('productoTamano').value = producto?.presentacion || '';
    document.getElementById('productoDescripcion').value = producto?.descripcion || '';
    document.getElementById('productoDisponible').value = producto && !producto.disponible ? 'false' : 'true';
    imagenProductoTemporal = producto?.imagen || '';
    actualizarVistaPreviaProducto(imagenProductoTemporal);
    borradorRecetasProducto = {};
    (producto?.recetas || []).forEach(r => {
        borradorRecetasProducto[r.tamano] = Object.fromEntries(r.ingredientes.map(i => [i.ingredienteId, i.cantidad]));
    });
    tamanoRecetaProductoActual = null;
    actualizarFormularioProductoCategoria();
    document.getElementById('productoImagenArchivo').value = '';
    document.getElementById('modalProducto').classList.add('activo');
}

function actualizarFormularioProductoCategoria() {
    capturarRecetaProductoActual();
    const esPizza = document.getElementById('productoCategoria').value === 'Pizzas';
    document.getElementById('productoPrecioEtiqueta').textContent = esPizza ? 'Precio Personal *' : 'Precio de venta *';
    document.getElementById('productoPrecioMedianaGrupo').hidden = !esPizza;
    document.getElementById('productoPrecioFamiliarGrupo').hidden = !esPizza;
    document.getElementById('productoPresentacionGrupo').hidden = esPizza;
    document.getElementById('selectorTamanoRecetaWrap').hidden = !esPizza;
    document.getElementById('productoPrecioMediana').required = esPizza;
    document.getElementById('productoPrecioFamiliar').required = esPizza;
    const selector = document.getElementById('productoRecetaTamano');
    const previo = tamanoRecetaProductoActual;
    selector.innerHTML = (esPizza ? TAMANOS_PIZZA : ['']).map(t => `<option value="${t}">${t || 'Por unidad'}</option>`).join('');
    selector.value = esPizza && TAMANOS_PIZZA.includes(previo) ? previo : (esPizza ? 'Personal' : '');
    tamanoRecetaProductoActual = null;
    cargarIngredientesProducto(false);
}

function capturarRecetaProductoActual() {
    if (tamanoRecetaProductoActual === null) return;
    const receta = {};
    document.querySelectorAll('#productoIngredientesFilas .composicion-fila').forEach(fila => {
        const ingredienteId = fila.querySelector('[data-producto-ingrediente]').value;
        const cantidad = Number(fila.querySelector('[data-producto-cantidad]').value);
        if (ingredienteId && Number.isFinite(cantidad) && cantidad > 0) receta[ingredienteId] = (receta[ingredienteId] || 0) + cantidad;
    });
    borradorRecetasProducto[tamanoRecetaProductoActual] = receta;
}

function cargarIngredientesProducto(guardarActual = true) {
    if (guardarActual) capturarRecetaProductoActual();
    const tamano = document.getElementById('productoRecetaTamano').value;
    const filas = document.getElementById('productoIngredientesFilas');
    filas.replaceChildren();
    const entradas = Object.entries(borradorRecetasProducto[tamano] || {});
    if (entradas.length) entradas.forEach(([ingredienteId, cantidad]) => agregarIngredienteAProducto(ingredienteId, cantidad));
    else agregarIngredienteAProducto();
    tamanoRecetaProductoActual = tamano;
}

function agregarIngredienteAProducto(ingredienteSeleccionado = '', cantidad = '') {
    const fila = document.createElement('div');
    fila.className = 'composicion-fila';
    fila.innerHTML = `
        <select class="form-input" data-producto-ingrediente aria-label="Ingrediente requerido">
            <option value="">Seleccionar ingrediente</option>
            ${Datos.ingredientes.filter(i => i.activo || String(i.id) === String(ingredienteSeleccionado)).map(i => `<option value="${i.id}" ${String(i.id) === String(ingredienteSeleccionado) ? 'selected' : ''}>${escaparHTML(i.nombre)} (${escaparHTML(i.unidad)})</option>`).join('')}
        </select>
        <input class="form-input" data-producto-cantidad type="number" min="0.001" step="0.001" value="${cantidad}" placeholder="Cantidad" aria-label="Cantidad necesaria">
        <button type="button" class="accion-btn accion-eliminar" aria-label="Quitar ingrediente" onclick="this.closest('.composicion-fila').remove()">Quitar</button>`;
    document.getElementById('productoIngredientesFilas').append(fila);
}

function previsualizarImagenProducto(evento) {
    const archivo = evento.target.files[0];
    if (!archivo) return;
    const error = document.getElementById('errorFormularioProducto');
    if (!archivo.type.startsWith('image/') || archivo.size > 3 * 1024 * 1024) {
        error.textContent = 'Selecciona una imagen de máximo 3 MB.';
        error.hidden = false;
        evento.target.value = '';
        return;
    }
    const lector = new FileReader();
    lector.onload = () => {
        imagenProductoTemporal = lector.result;
        actualizarVistaPreviaProducto(imagenProductoTemporal);
    };
    lector.readAsDataURL(archivo);
}

function actualizarVistaPreviaProducto(src) {
    const imagen = document.getElementById('productoImagenPreview');
    const placeholder = document.getElementById('productoImagenPlaceholder');
    imagen.hidden = !src;
    placeholder.hidden = Boolean(src);
    if (src) imagen.src = src;
    else imagen.removeAttribute('src');
}

function cerrarModalProducto() {
    cerrarModal('modalProducto');
    document.getElementById('formularioProducto').reset();
    document.getElementById('productoImagenArchivo').value = '';
    imagenProductoTemporal = '';
}

function guardarProducto(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('guardar productos')) return;
        const error = document.getElementById('errorFormularioProducto');
        error.hidden = true;
        const mostrarError = mensaje => { error.textContent = mensaje; error.hidden = false; };
        const id = document.getElementById('productoIdEdicion').value;
        const categoria = document.getElementById('productoCategoria').value;
        const esPizza = categoria === 'Pizzas';
        const precio = Number(document.getElementById('productoPrecio').value);
        const precioMediana = Number(document.getElementById('productoPrecioMediana').value);
        const precioFamiliar = Number(document.getElementById('productoPrecioFamiliar').value);
        const nombre = document.getElementById('productoNombre').value.trim();
        if (!nombre || !Number.isFinite(precio) || precio < 0) return mostrarError('El nombre es obligatorio y el precio debe ser un número igual o mayor que cero.');
        if (esPizza && (!(precio > 0) || !(precioMediana > 0) || !(precioFamiliar > 0))) {
            return mostrarError('Las pizzas necesitan un precio mayor que cero para Personal, Mediana y Familiar.');
        }

        capturarRecetaProductoActual();
        const recetas = [];
        for (const tamano of esPizza ? TAMANOS_PIZZA : ['']) {
            const ingredientes = Object.entries(borradorRecetasProducto[tamano] || {}).map(([ingredienteId, cantidad]) => ({ ingredienteId: Number(ingredienteId), cantidad }));
            if (!ingredientes.length) return mostrarError(esPizza ? `Configura al menos un ingrediente con cantidad válida para el tamaño ${tamano}.` : 'Configura al menos un ingrediente (o el artículo de inventario) que consume una unidad.');
            recetas.push({ tamano, ingredientes });
        }
        try {
            await api(id ? `/api/productos/${id}` : '/api/productos', {
                metodo: id ? 'PUT' : 'POST', sesion: 'staff',
                cuerpo: {
                    nombre, categoria, precio,
                    precioMediana: esPizza ? precioMediana : null,
                    precioFamiliar: esPizza ? precioFamiliar : null,
                    descripcion: document.getElementById('productoDescripcion').value.trim(),
                    presentacion: esPizza ? '' : document.getElementById('productoTamano').value.trim(),
                    disponible: document.getElementById('productoDisponible').value === 'true',
                    imagen: imagenProductoTemporal,
                    recetas
                }
            });
            cerrarModalProducto();
            await Promise.all([recargarProductosAdmin(), cargarCatalogo({ silencioso: true }), recargarPromocionesAdmin()]);
            renderizarTablaProductos();
            renderizarTablaPromociones();
            renderizarOpcionesInventario();
            mostrarNotificacion(id ? 'Producto actualizado.' : 'Producto creado. El inventario no se modificó.');
        } catch (errorApi) {
            mostrarError(errorApi.message);
        }
    });
}

function eliminarProducto(id) {
    if (!exigirAdministrador('eliminar productos')) return;
    const producto = Datos.catalogoAdmin.find(p => p.id === id);
    if (!producto) return;
    pedirConfirmacionEntidad('Eliminar producto', `¿Estás segura de que deseas eliminar ${producto.nombre}? Si tiene ventas o promociones asociadas solo se marcará como no disponible.`, 'Sí, eliminar', async () => {
        try {
            const respuesta = await api(`/api/productos/${id}`, { metodo: 'DELETE', sesion: 'staff' });
            await Promise.all([recargarProductosAdmin(), cargarCatalogo({ silencioso: true }), recargarPromocionesAdmin()]);
            renderizarTablaProductos();
            renderizarTablaPromociones();
            mostrarNotificacion(respuesta.mensaje);
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
        }
    });
}

/* ===================================================================
   COMBOS Y PROMOCIONES (administración)
   =================================================================== */

function etiquetaTipoDescuento(tipoUI) {
    return { precio: 'Precio especial', 'descuento-fijo': 'Descuento fijo', porcentaje: 'Descuento (%)' }[tipoUI] || 'Descuento';
}

function actualizarEtiquetaDescuento() {
    const etiqueta = document.getElementById('promocionEtiquetaDescuento');
    if (etiqueta) etiqueta.textContent = etiquetaTipoDescuento(document.getElementById('promocionTipoDescuento').value);
}

function mostrarFormularioPromocion() {
    if (!exigirAdministrador('administrar promociones')) return;
    abrirFormularioPromocion();
}

function leerComponentesPromocion() {
    return [...document.querySelectorAll('#promocionComponentes .promocion-componente-fila')].map(fila => ({
        productoId: Number(fila.querySelector('[data-promocion-producto]').value),
        tamano: fila.querySelector('[data-promocion-tamano]').value,
        cantidad: Number(fila.querySelector('[data-promocion-cantidad]').value)
    }));
}

function agregarComponentePromocion(componente = null) {
    if (!exigirAdministrador('administrar promociones')) return;
    const fila = document.createElement('div');
    fila.className = 'composicion-fila promocion-componente-fila';
    const opciones = Datos.catalogoAdmin.filter(p => p.disponible || p.id === componente?.productoId);
    const inicial = componente?.productoId || opciones[0]?.id;
    fila.innerHTML = `
        <select class="form-input" data-promocion-producto aria-label="Producto del combo">
            ${opciones.map(p => `<option value="${p.id}" ${p.id === inicial ? 'selected' : ''}>${escaparHTML(p.nombre)}</option>`).join('')}
        </select>
        <select class="form-input" data-promocion-tamano aria-label="Tamaño"></select>
        <input class="form-input" data-promocion-cantidad type="number" min="1" max="20" step="1" value="${Number(componente?.cantidad) || 1}" aria-label="Cantidad">
        <button type="button" class="accion-btn accion-eliminar" aria-label="Quitar producto" onclick="this.closest('.promocion-componente-fila').remove(); actualizarVistaPreviaPromocion()">Quitar</button>`;
    document.getElementById('promocionComponentes').append(fila);
    fila.querySelector('[data-promocion-producto]').addEventListener('change', () => actualizarTamanoComponentePromocion(fila));
    fila.querySelector('[data-promocion-tamano]').addEventListener('change', actualizarVistaPreviaPromocion);
    fila.querySelector('[data-promocion-cantidad]').addEventListener('input', actualizarVistaPreviaPromocion);
    actualizarTamanoComponentePromocion(fila, componente?.tamano || '');
}

function actualizarTamanoComponentePromocion(fila, tamanoPreferido = '') {
    const producto = Datos.catalogoAdmin.find(p => p.id === Number(fila.querySelector('[data-promocion-producto]').value));
    const selector = fila.querySelector('[data-promocion-tamano]');
    const esPizza = producto?.categoria === 'Pizzas';
    selector.innerHTML = esPizza ? TAMANOS_PIZZA.map(t => `<option value="${t}">${t}</option>`).join('') : '<option value="">Unidad</option>';
    selector.disabled = !esPizza;
    selector.value = esPizza ? (TAMANOS_PIZZA.includes(tamanoPreferido) ? tamanoPreferido : 'Personal') : '';
    actualizarVistaPreviaPromocion();
}

/** Misma regla que el servidor (PromocionCalculadora) para mostrar la vista previa antes de guardar. */
function calcularPromocionLocal(componentes, tipoUI, valor) {
    if (!componentes.length) return null;
    let normal = 0;
    for (const c of componentes) {
        const producto = Datos.catalogoAdmin.find(p => p.id === c.productoId);
        if (!producto || !Number.isInteger(c.cantidad) || c.cantidad <= 0) return null;
        normal += precioProducto(producto, c.tamano) * c.cantidad;
    }
    normal = redondear2(normal);
    const v = Math.max(0, Number(valor) || 0);
    let descuento = tipoUI === 'precio' ? normal - Math.min(normal, v)
        : tipoUI === 'porcentaje' ? normal * Math.min(100, v) / 100
            : Math.min(normal, v);
    descuento = redondear2(Math.min(normal, descuento));
    return { normal, descuento, final: normal - descuento };
}

function actualizarVistaPreviaPromocion() {
    const componentes = leerComponentesPromocion();
    const calculo = calcularPromocionLocal(componentes, document.getElementById('promocionTipoDescuento').value, document.getElementById('promocionDescuento').value);
    const preview = document.getElementById('promocionVistaPrevia');
    if (!calculo) {
        preview.textContent = 'Selecciona productos y cantidades válidas para ver la vista previa.';
        return;
    }
    const nombres = componentes.map(c => `${Datos.catalogoAdmin.find(p => p.id === c.productoId)?.nombre || 'Producto'}${c.tamano ? ` (${c.tamano})` : ''} × ${c.cantidad}`).join(', ');
    preview.innerHTML = `<strong>${escaparHTML(nombres)}</strong><br>Precio normal: ${formatearCOP(calculo.normal)} · Descuento: ${formatearCOP(calculo.descuento)} · Precio final: ${formatearCOP(calculo.final)}`;
}

function abrirFormularioPromocion(id = null) {
    if (!exigirAdministrador('administrar promociones')) return;
    const promocion = id === null ? null : Datos.promocionesAdmin.find(p => p.id === id);
    if (id !== null && !promocion) return;
    document.getElementById('formularioPromocion').hidden = false;
    document.getElementById('tituloFormularioPromocion').textContent = promocion ? 'Editar promoción' : 'Nueva promoción';
    document.getElementById('promocionId').value = promocion?.id ?? '';
    document.getElementById('promocionNombre').value = promocion?.nombre || '';
    document.getElementById('promocionDescripcion').value = promocion?.descripcion || '';
    document.getElementById('promocionPublico').value = promocion?.publico || 'general';
    const tipo = promocion?.tipoDescuento || 'precio';
    document.getElementById('promocionTipoDescuento').value = tipo === 'fijo' ? 'descuento-fijo' : tipo;
    document.getElementById('promocionDescuento').value = promocion?.valorDescuento ?? '';
    document.getElementById('promocionFechaInicio').value = promocion?.fechaInicio || '';
    document.getElementById('promocionFechaFin').value = promocion?.fechaFin || '';
    actualizarEtiquetaDescuento();
    document.getElementById('promocionComponentes').replaceChildren();
    (promocion?.componentes || []).forEach(c => agregarComponentePromocion(c));
    if (!promocion) agregarComponentePromocion();
    document.getElementById('errorPromocion').classList.remove('activo');
    actualizarVistaPreviaPromocion();
    document.getElementById('formularioPromocion').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ocultarFormularioPromocion() {
    document.getElementById('formularioPromocion').hidden = true;
    document.getElementById('promocionComponentes').replaceChildren();
    document.getElementById('errorPromocion').classList.remove('activo');
}

function guardarPromocion(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('guardar promociones')) return;
        const error = document.getElementById('errorPromocion');
        const mostrarError = mensaje => { error.textContent = mensaje; error.classList.add('activo'); };
        const id = document.getElementById('promocionId').value;
        const tipoUI = document.getElementById('promocionTipoDescuento').value;
        const valor = Number(document.getElementById('promocionDescuento').value);
        const componentes = leerComponentesPromocion();
        const fechaInicio = document.getElementById('promocionFechaInicio').value;
        const fechaFin = document.getElementById('promocionFechaFin').value;
        const calculo = calcularPromocionLocal(componentes, tipoUI, valor);
        if (!calculo || !Number.isFinite(valor) || valor < 0 || (tipoUI === 'porcentaje' && valor > 100)
            || (tipoUI === 'precio' && valor > calculo.normal) || (fechaInicio && fechaFin && fechaInicio > fechaFin)) {
            return mostrarError('Revisa nombre, descripción, productos, cantidades, descuento y fechas.');
        }
        const anterior = id ? Datos.promocionesAdmin.find(p => p.id === Number(id)) : null;
        try {
            await api(id ? `/api/promociones/${id}` : '/api/promociones', {
                metodo: id ? 'PUT' : 'POST', sesion: 'staff',
                cuerpo: {
                    nombre: document.getElementById('promocionNombre').value.trim(),
                    descripcion: document.getElementById('promocionDescripcion').value.trim(),
                    emoji: anterior?.emoji || '🎁',
                    imagen: anterior?.imagen || undefined,
                    publico: document.getElementById('promocionPublico').value,
                    tipoDescuento: tipoUI === 'descuento-fijo' ? 'fijo' : tipoUI,
                    valorDescuento: valor,
                    fechaInicio: fechaInicio || null,
                    fechaFin: fechaFin || null,
                    activa: anterior ? anterior.activa : true,
                    componentes
                }
            });
            ocultarFormularioPromocion();
            await Promise.all([recargarPromocionesAdmin(), cargarCatalogo({ silencioso: true }), recargarPromocionesInternas()]);
            renderizarTablaPromociones();
            mostrarNotificacion(id ? 'Promoción actualizada.' : 'Promoción creada.');
        } catch (errorApi) {
            mostrarError(errorApi.message);
        }
    });
}

async function alternarPromocion(id) {
    if (!exigirAdministrador('cambiar el estado de promociones')) return;
    const promocion = Datos.promocionesAdmin.find(p => p.id === id);
    if (!promocion) return;
    try {
        await api(`/api/promociones/${id}/estado`, { metodo: 'PATCH', sesion: 'staff', cuerpo: { activa: !promocion.activa } });
        await Promise.all([recargarPromocionesAdmin(), cargarCatalogo({ silencioso: true }), recargarPromocionesInternas()]);
        renderizarTablaPromociones();
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
}

function eliminarPromocion(id) {
    if (!exigirAdministrador('eliminar promociones')) return;
    pedirConfirmacionEntidad('Eliminar promoción', '¿Eliminar esta promoción? Si ya se vendió en pedidos solo se desactivará.', 'Sí, eliminar', async () => {
        try {
            const respuesta = await api(`/api/promociones/${id}`, { metodo: 'DELETE', sesion: 'staff' });
            pedidoCliente = pedidoCliente.filter(l => l.promocionId !== id);
            await Promise.all([recargarPromocionesAdmin(), cargarCatalogo({ silencioso: true }), recargarPromocionesInternas()]);
            renderizarTablaPromociones();
            mostrarNotificacion(respuesta.mensaje);
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
        }
    });
}

function renderizarTablaPromociones() {
    const tabla = document.getElementById('tablaPromociones');
    if (!tabla) return;
    if (!esAdministradorActual()) {
        tabla.replaceChildren();
        return;
    }
    tabla.innerHTML = Datos.promocionesAdmin.length ? Datos.promocionesAdmin.map(p => {
        const vigencia = [p.fechaInicio, p.fechaFin].filter(Boolean).join(' → ') || 'Sin fecha';
        const estado = !p.activa ? 'Inactivo' : p.vigente ? 'Activo' : 'Pendiente';
        return `<tr>
            <td><strong>${escaparHTML(p.nombre)}</strong><small class="detalle-componentes">${escaparHTML(p.descripcion)}</small></td>
            <td>${escaparHTML(resumenProductos(p.componentes.map(c => ({ nombre: c.producto, tamano: c.tamano, cantidad: c.cantidad }))))}</td>
            <td>${p.precioNormal != null ? formatearCOP(p.precioNormal) : '—'}</td>
            <td>${p.precioFinal != null ? formatearCOP(p.precioFinal) : 'Configuración inválida'}</td>
            <td>${p.publico === 'clientes' ? 'Clientes registrados' : 'General'}</td>
            <td>${escaparHTML(vigencia)}</td>
            <td>${badgeEstado(estado)}${p.activa && !p.vigente ? '<small class="detalle-componentes">Fuera de vigencia</small>' : ''}</td>
            <td><div class="tabla-acciones">
                <button class="accion-btn accion-editar" onclick="abrirFormularioPromocion(${p.id})">Editar</button>
                <button class="accion-btn ${p.activa ? 'accion-eliminar' : 'accion-editar'}" onclick="alternarPromocion(${p.id})">${p.activa ? 'Desactivar' : 'Activar'}</button>
                <button class="accion-btn accion-eliminar" onclick="eliminarPromocion(${p.id})">Eliminar</button>
            </div></td>
        </tr>`;
    }).join('') : '<tr><td colspan="8" class="tabla-vacia">Aún no hay promociones.</td></tr>';
}

/* ===================================================================
   CLIENTES, PROVEEDORES Y USUARIOS
   =================================================================== */

function renderizarTablaClientes() {
    const tabla = document.getElementById('tablaClientes');
    if (!puedeAccederModulo('clientes')) {
        tabla.replaceChildren();
        return false;
    }
    tabla.innerHTML = Datos.clientes.length ? Datos.clientes.map(c => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(c.nombre)}</td>
            <td style="color: var(--gray-500);">${escaparHTML(c.identificacion || '—')}</td>
            <td style="color: var(--gray-500);">${escaparHTML(c.telefono || '—')}</td>
            <td style="color: var(--gray-500);">${escaparHTML(c.direccion || '—')}</td>
            <td style="color: var(--gray-500);">${escaparHTML(c.correo || '—')}</td>
            <td>${badgeEstado(c.activo ? 'Activo' : 'Inactivo')}</td>
            <td><div class="tabla-acciones">${esAdministradorActual() && c.activo ? `<button class="accion-btn accion-eliminar" onclick="eliminarCliente(${c.id})">Eliminar</button>` : ''}</div></td>
        </tr>`).join('') : '<tr><td colspan="7" class="tabla-vacia">Aún no hay clientes registrados.</td></tr>';
}

function eliminarCliente(id) {
    if (!exigirAdministrador('eliminar clientes')) return;
    const cliente = Datos.clientes.find(c => c.id === id);
    if (!cliente) return;
    pedirConfirmacionEntidad('Eliminar cliente', `¿Eliminar a ${cliente.nombre}? Si tiene pedidos asociados se desactivará y se conservará su historial.`, 'Sí, eliminar', async () => {
        try {
            const respuesta = await api(`/api/clientes/${id}`, { metodo: 'DELETE', sesion: 'staff' });
            await recargarClientes();
            renderizarTablaClientes();
            actualizarDashboard();
            mostrarNotificacion(respuesta.mensaje);
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
        }
    });
}

function renderizarTablaProveedores() {
    const tabla = document.getElementById('tablaProveedores');
    if (!tabla || !esAdministradorActual()) return;
    tabla.innerHTML = Datos.proveedores.length ? Datos.proveedores.map(p => `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(p.nombre)}</td>
            <td style="color: var(--gray-500);">${escaparHTML(p.telefono || '—')}</td>
            <td style="color: var(--gray-500);">${escaparHTML(p.correo || '—')}</td>
            <td style="color: var(--gray-500);">${escaparHTML(p.productos || '—')}</td>
            <td>${badgeEstado(p.activo ? 'Activo' : 'Inactivo')}</td>
            <td><div class="tabla-acciones">
                <button class="accion-btn accion-editar" onclick="abrirFormularioProveedor(${p.id})">Editar</button>
                <button class="accion-btn ${p.activo ? 'accion-eliminar' : 'accion-editar'}" onclick="alternarEstadoProveedor(${p.id})">${p.activo ? 'Desactivar' : 'Activar'}</button>
                <button class="accion-btn accion-eliminar" onclick="eliminarProveedor(${p.id})">Eliminar</button>
            </div></td>
        </tr>`).join('') : '<tr><td colspan="6" class="tabla-vacia">Aún no hay proveedores.</td></tr>';
}

function abrirFormularioProveedor(id = null) {
    if (!exigirAdministrador('administrar proveedores')) return;
    const proveedor = id === null ? null : Datos.proveedores.find(p => p.id === id);
    if (id !== null && !proveedor) return;
    document.getElementById('formularioProveedor').reset();
    document.getElementById('proveedorId').value = proveedor?.id ?? '';
    document.getElementById('tituloModalProveedor').textContent = proveedor ? 'Editar proveedor' : 'Nuevo proveedor';
    document.getElementById('proveedorNombre').value = proveedor?.nombre || '';
    document.getElementById('proveedorEmpresa').value = proveedor?.empresa || '';
    document.getElementById('proveedorIdentificacion').value = proveedor?.identificacion || '';
    document.getElementById('proveedorTelefono').value = proveedor?.telefono || '';
    document.getElementById('proveedorCorreo').value = proveedor?.correo || '';
    document.getElementById('proveedorDireccion').value = proveedor?.direccion || '';
    document.getElementById('proveedorProductos').value = proveedor?.productos || '';
    document.getElementById('proveedorObservaciones').value = proveedor?.observaciones || '';
    document.getElementById('proveedorEstado').value = proveedor && !proveedor.activo ? 'Inactivo' : 'Activo';
    const error = document.getElementById('errorFormularioProveedor');
    error.textContent = '';
    error.classList.remove('activo');
    document.getElementById('modalProveedor').classList.add('activo');
}

function cerrarModalProveedor() {
    cerrarModal('modalProveedor');
    document.getElementById('formularioProveedor').reset();
    document.getElementById('errorFormularioProveedor').classList.remove('activo');
}

function guardarProveedor(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('guardar proveedores')) return;
        const error = document.getElementById('errorFormularioProveedor');
        const id = document.getElementById('proveedorId').value;
        try {
            await api(id ? `/api/proveedores/${id}` : '/api/proveedores', {
                metodo: id ? 'PUT' : 'POST', sesion: 'staff',
                cuerpo: {
                    nombre: document.getElementById('proveedorNombre').value.trim(),
                    empresa: document.getElementById('proveedorEmpresa').value.trim(),
                    identificacion: document.getElementById('proveedorIdentificacion').value.trim(),
                    telefono: document.getElementById('proveedorTelefono').value.trim(),
                    correo: document.getElementById('proveedorCorreo').value.trim(),
                    direccion: document.getElementById('proveedorDireccion').value.trim(),
                    productos: document.getElementById('proveedorProductos').value.trim(),
                    observaciones: document.getElementById('proveedorObservaciones').value.trim(),
                    activo: document.getElementById('proveedorEstado').value === 'Activo'
                }
            });
            cerrarModalProveedor();
            await Promise.all([recargarProveedores(), recargarIngredientes()]);
            renderizarTablaProveedores();
            renderizarTablaInventario();
            mostrarNotificacion(id ? 'Proveedor actualizado.' : 'Proveedor guardado correctamente.');
        } catch (errorApi) {
            error.textContent = errorApi.message;
            error.classList.add('activo');
        }
    });
}

async function alternarEstadoProveedor(id) {
    if (!exigirAdministrador('cambiar el estado de proveedores')) return;
    const proveedor = Datos.proveedores.find(p => p.id === id);
    if (!proveedor) return;
    try {
        await api(`/api/proveedores/${id}/estado`, { metodo: 'PATCH', sesion: 'staff', cuerpo: { activa: !proveedor.activo } });
        await recargarProveedores();
        renderizarTablaProveedores();
        mostrarNotificacion(`Proveedor ${proveedor.activo ? 'inactivo' : 'activo'}.`);
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
}

function eliminarProveedor(id) {
    if (!exigirAdministrador('eliminar proveedores')) return;
    const proveedor = Datos.proveedores.find(p => p.id === id);
    if (!proveedor) return;
    pedirConfirmacionEntidad('Eliminar proveedor', `¿Eliminar al proveedor ${proveedor.nombre}? Si está ligado a ingredientes solo se desactivará.`, 'Sí, eliminar', async () => {
        try {
            const respuesta = await api(`/api/proveedores/${id}`, { metodo: 'DELETE', sesion: 'staff' });
            await Promise.all([recargarProveedores(), recargarIngredientes()]);
            renderizarTablaProveedores();
            renderizarTablaInventario();
            mostrarNotificacion(respuesta.mensaje);
        } catch (error) {
            mostrarNotificacion(error.message, 'error');
        }
    });
}

/* ------------------------------ Usuarios ------------------------------ */

function renderizarTablaUsuarios() {
    const tabla = document.getElementById('tablaUsuarios');
    if (!esAdministradorActual()) {
        tabla.replaceChildren();
        return false;
    }
    tabla.innerHTML = Datos.usuarios.map(u => {
        const esCuentaActual = usuarioActual?.id === u.id;
        const rol = normalizarRol(u.rol);
        return `
        <tr>
            <td style="font-weight: 600;">${escaparHTML(u.nombre)}</td>
            <td style="color: var(--gray-500);">${escaparHTML(u.correo)}</td>
            <td>
                <select class="form-input usuario-rol-select" data-usuario-rol="${u.id}" aria-label="Rol de ${escaparHTML(u.nombre)}" ${esCuentaActual ? 'disabled' : ''}>
                    <option value="Cajero" ${rol === 'Cajero' ? 'selected' : ''}>Personal de caja</option>
                    <option value="Mesera" ${rol === 'Mesera' ? 'selected' : ''}>Personal de mesas</option>
                    <option value="Administrador" ${rol === 'Administrador' ? 'selected' : ''}>Administrador</option>
                </select>
            </td>
            <td>${badgeEstado(u.activo ? 'Activo' : 'Inactivo')}</td>
            <td><div class="tabla-acciones">
                <button class="accion-btn ${u.activo ? 'accion-eliminar' : 'accion-editar'}" data-usuario-estado="${u.id}" ${esCuentaActual ? 'disabled' : ''}>${u.activo ? 'Desactivar' : 'Activar'}</button>
                <button class="accion-btn accion-editar" data-usuario-reset="${u.id}">Restablecer acceso</button>
            </div></td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" class="tabla-vacia">No hay usuarios.</td></tr>';
    tabla.querySelectorAll('[data-usuario-rol]').forEach(s => s.addEventListener('change', () => actualizarRolUsuario(Number(s.dataset.usuarioRol), s.value)));
    tabla.querySelectorAll('[data-usuario-estado]').forEach(b => b.addEventListener('click', () => alternarEstadoUsuario(Number(b.dataset.usuarioEstado))));
    tabla.querySelectorAll('[data-usuario-reset]').forEach(b => b.addEventListener('click', () => abrirRestablecimientoUsuario(Number(b.dataset.usuarioReset))));
    return true;
}

function mostrarFormularioUsuario() {
    if (!exigirAdministrador('crear cuentas internas')) return;
    document.getElementById('errorFormularioUsuario').classList.remove('activo');
    document.getElementById('formularioUsuarioInterno').hidden = false;
}

function ocultarFormularioUsuario() {
    const formulario = document.getElementById('formularioUsuarioInterno');
    formulario.hidden = true;
    formulario.querySelector('form').reset();
    formulario.querySelectorAll('.password-control input').forEach(restablecerVisibilidadPassword);
    document.getElementById('errorFormularioUsuario').classList.remove('activo');
}

function crearUsuarioInterno(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('crear cuentas internas')) return;
        const error = document.getElementById('errorFormularioUsuario');
        const campoPassword = document.getElementById('nuevoUsuarioPassword');
        try {
            await api('/api/usuarios', {
                metodo: 'POST', sesion: 'staff',
                cuerpo: {
                    nombre: document.getElementById('nuevoUsuarioNombre').value.trim(),
                    correo: document.getElementById('nuevoUsuarioCorreo').value.trim(),
                    password: campoPassword.value,
                    rol: document.getElementById('nuevoUsuarioRol').value
                }
            });
            ocultarFormularioUsuario();
            await recargarUsuarios();
            renderizarTablaUsuarios();
            mostrarNotificacion('Cuenta creada. La contraseña se guardó cifrada en el servidor.');
        } catch (errorApi) {
            error.textContent = errorApi.message;
            error.classList.add('activo');
            campoPassword.value = '';
            restablecerVisibilidadPassword(campoPassword);
        }
    });
}

async function actualizarRolUsuario(id, rol) {
    if (!exigirAdministrador('cambiar roles')) return false;
    try {
        await api(`/api/usuarios/${id}`, { metodo: 'PUT', sesion: 'staff', cuerpo: { rol } });
        mostrarNotificacion('Rol actualizado.');
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
    await recargarUsuarios();
    renderizarTablaUsuarios();
    return true;
}

async function alternarEstadoUsuario(id) {
    if (!exigirAdministrador('cambiar el estado de cuentas')) return false;
    const usuario = Datos.usuarios.find(u => u.id === id);
    if (!usuario) return false;
    try {
        await api(`/api/usuarios/${id}`, { metodo: 'PUT', sesion: 'staff', cuerpo: { activo: !usuario.activo } });
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
    }
    await recargarUsuarios();
    renderizarTablaUsuarios();
    return true;
}

function abrirRestablecimientoUsuario(id) {
    if (!exigirAdministrador('restablecer contraseñas')) return false;
    const usuario = Datos.usuarios.find(u => u.id === id);
    if (!usuario) return false;
    document.getElementById('formularioRestablecerPassword').reset();
    document.getElementById('usuarioResetId').value = id;
    document.getElementById('usuarioResetNombre').textContent = `${usuario.nombre} (${usuario.correo})`;
    const error = document.getElementById('errorRestablecerPassword');
    error.textContent = '';
    error.classList.remove('activo');
    document.getElementById('modalRestablecerPassword').classList.add('activo');
    return true;
}

function restablecerPasswordUsuario(evento) {
    return conBloqueo(evento, async () => {
        if (!exigirAdministrador('restablecer contraseñas')) return;
        const error = document.getElementById('errorRestablecerPassword');
        const campo = document.getElementById('usuarioResetPassword');
        try {
            await api(`/api/usuarios/${document.getElementById('usuarioResetId').value}/password`, {
                metodo: 'POST', sesion: 'staff', cuerpo: { password: campo.value }
            });
            cerrarModal('modalRestablecerPassword');
            mostrarNotificacion('Contraseña actualizada. La persona debe usar la nueva clave en su próximo inicio de sesión.');
        } catch (errorApi) {
            error.textContent = errorApi.message;
            error.classList.add('activo');
        } finally {
            campo.value = '';
            restablecerVisibilidadPassword(campo);
        }
    });
}

/* ===================================================================
   PEDIDOS INTERNOS (mesa y mostrador)
   =================================================================== */

function clienteSeleccionadoModal() {
    const id = Number(document.getElementById('pedidoCliente').value);
    return Datos.clientes.find(c => c.id === id && c.activo) || null;
}

function abrirModalPedido() {
    if (!exigirModulo('pedidos', 'crear pedidos')) return;
    pedidoModal = [];
    categoriaModalActual = 'Pizzas';
    const selectorCliente = document.getElementById('pedidoCliente');
    selectorCliente.innerHTML = '<option value="">Cliente mostrador</option>' + Datos.clientes
        .filter(c => c.activo).map(c => `<option value="${c.id}">${escaparHTML(c.nombre)}</option>`).join('');
    selectorCliente.onchange = () => {
        const registrado = Boolean(clienteSeleccionadoModal());
        pedidoModal = pedidoModal.filter(l => !l.esOfertaCliente || registrado);
        if (categoriaModalActual === 'Combos') renderizarProductosModalPedido();
        renderizarItemsModalPedido();
    };
    document.getElementById('pedidoMesa').value = '';
    document.getElementById('pedidoObservaciones').value = '';
    const selectorTipo = document.getElementById('pedidoTipo');
    [...selectorTipo.options].forEach(opcion => {
        opcion.hidden = (usuarioActual?.rol === 'Mesera' && opcion.value !== 'Mesa') || (usuarioActual?.rol === 'Cajero' && opcion.value !== 'Recoger');
        opcion.disabled = opcion.hidden;
    });
    selectorTipo.value = usuarioActual?.rol === 'Mesera' ? 'Mesa' : usuarioActual?.rol === 'Cajero' ? 'Recoger' : 'Mesa';
    actualizarCamposPedido();
    document.querySelectorAll('[data-cat-pedido]').forEach(b => b.classList.toggle('activa', b.dataset.catPedido === 'Pizzas'));
    renderizarProductosModalPedido();
    renderizarItemsModalPedido();
    document.getElementById('modalPedido').classList.add('activo');
    // Refresca existencias y combos justo antes de armar el pedido.
    Promise.all([cargarCatalogo({ silencioso: true }), recargarPromocionesInternas().catch(() => {})]).then(() => {
        if (document.getElementById('modalPedido').classList.contains('activo')) renderizarProductosModalPedido();
    });
}

function actualizarCamposPedido() {
    const tipo = document.getElementById('pedidoTipo').value;
    document.getElementById('pedidoMesaGrupo').hidden = tipo !== 'Mesa';
    document.getElementById('pedidoMesa').required = tipo === 'Mesa';
}

function filtrarPedidoCategoria(categoria, boton) {
    if (!exigirModulo('pedidos', 'filtrar productos del pedido')) return;
    document.querySelectorAll('[data-cat-pedido]').forEach(b => b.classList.remove('activa'));
    boton.classList.add('activa');
    categoriaModalActual = categoria;
    renderizarProductosModalPedido();
}

function renderizarProductosModalPedido() {
    if (!puedeAccederModulo('pedidos')) return false;
    const contenedor = document.getElementById('productosModalPedido');
    if (categoriaModalActual === 'Combos') {
        const registrado = Boolean(clienteSeleccionadoModal());
        const promociones = Datos.promocionesInternas.filter(p => p.publico === 'general' || registrado);
        contenedor.innerHTML = promociones.length ? promociones.map(p => {
            const disponibilidad = estadoDisponibilidadComponentes(p.componentes);
            return `
            <div class="producto-card">
                <div class="producto-imagen">${fotoPromocion(p) ? imagenHTML(fotoPromocion(p), p.nombre) : escaparHTML(p.emoji || '🎁')}</div>
                <div class="producto-nombre">${escaparHTML(p.nombre)}</div>
                <div class="producto-descripcion">${escaparHTML(p.descripcion || '')}</div>
                ${disponibilidad.disponible ? '' : `<div class="producto-disponibilidad" role="status">${escaparHTML(disponibilidad.motivo)}</div>`}
                <div class="producto-footer">
                    <div class="producto-precio">${formatearCOP(p.precioFinal)}</div>
                    <button class="btn-agregar" onclick="agregarPromocionPedidoInterno(${p.id})" ${disponibilidad.disponible ? '' : 'disabled'}>${disponibilidad.disponible ? '+ Agregar combo' : 'No disponible'}</button>
                </div>
            </div>`;
        }).join('') : '<p class="tabla-vacia">No hay combos disponibles para este pedido.</p>';
        return true;
    }
    const productos = Datos.productos.filter(p => p.categoria === categoriaModalActual);
    contenedor.innerHTML = productos.length
        ? productos.map(p => htmlTarjetaProducto(p, 'pedido-', 'agregarAPedidoModal')).join('')
        : '<p class="tabla-vacia">No hay productos en esta categoría.</p>';
}

function agregarAPedidoModal(id, boton) {
    if (!exigirModulo('pedidos', 'agregar productos al pedido')) return;
    const producto = Datos.productos.find(p => p.id === id);
    if (!producto) return;
    const selector = producto.categoria === 'Pizzas' ? document.getElementById(`pedido-tamano-${id}`) : null;
    const resultado = agregarProductoACarrito(pedidoModal, producto, selector ? selector.value : '');
    if (!resultado.ok) {
        mostrarNotificacion(resultado.mensaje, 'error');
        return;
    }
    renderizarItemsModalPedido();
}

function agregarPromocionPedidoInterno(id) {
    if (!exigirModulo('pedidos', 'agregar combos al pedido')) return;
    const promocion = Datos.promocionesInternas.find(p => p.id === id);
    if (!promocion || (promocion.publico === 'clientes' && !clienteSeleccionadoModal())) {
        mostrarNotificacion('Este combo no está disponible para el pedido actual.', 'error');
        return;
    }
    const resultado = agregarPromocionACarrito(pedidoModal, promocion);
    if (!resultado.ok) mostrarNotificacion(resultado.mensaje, 'error');
    renderizarItemsModalPedido();
}

function cambiarCantidadModal(clave, delta) {
    const resultado = cambiarCantidadEnCarrito(pedidoModal, clave, delta);
    if (resultado.mensaje) mostrarNotificacion(resultado.mensaje, 'error');
    renderizarItemsModalPedido();
}

function renderizarItemsModalPedido() {
    const contenedor = document.getElementById('itemsModalPedido');
    contenedor.innerHTML = pedidoModal.length ? pedidoModal.map(l => {
        const clave = escaparHTML(l.clave);
        return `<div class="pedido-item">
            <div class="pedido-item-emoji">${escaparHTML(l.emoji)}</div>
            <div class="pedido-item-info">
                <div class="pedido-item-nombre">${escaparHTML(l.nombre)}${l.tamano ? ` · ${escaparHTML(l.tamano)}` : ''}</div>
                <div class="pedido-item-precio">${formatearCOP(l.precio)} c/u</div>
            </div>
            <div class="pedido-item-controles">
                <button type="button" class="pedido-item-btn" onclick="cambiarCantidadModal('${clave}', -1)" aria-label="Quitar una unidad">−</button>
                <span class="pedido-item-cantidad">${l.cantidad}</span>
                <button type="button" class="pedido-item-btn" onclick="cambiarCantidadModal('${clave}', 1)" aria-label="Agregar una unidad">+</button>
            </div>
        </div>`;
    }).join('') : '<p class="reporte-nota">Aún no has agregado productos al pedido.</p>';
    actualizarTotalPedidoModal();
}

/** Mismo cálculo de IVA/descuentos que el carrito público (calcularTotales). */
function actualizarTotalPedidoModal() {
    const totales = calcularTotales(pedidoModal);
    document.getElementById('totalModalPedido').textContent = formatearCOPConDecimales(totales.total);
    document.getElementById('detalleTotalModalPedido').textContent =
        `Subtotal ${formatearCOPConDecimales(totales.subtotal)} · Descuentos −${formatearCOPConDecimales(totales.descuento)} · IVA 16% ${formatearCOPConDecimales(totales.iva)}`;
}

async function confirmarPedido() {
    if (!exigirModulo('pedidos', 'registrar pedidos')) return;
    if (pedidoModal.length === 0) {
        alert('⚠️ Agrega productos al pedido');
        return;
    }
    const tipo = document.getElementById('pedidoTipo').value;
    const mesa = document.getElementById('pedidoMesa').value.trim();
    if (tipo === 'Mesa' && !mesa) {
        mostrarNotificacion('Indica la mesa del pedido.', 'error');
        const campoMesa = document.getElementById('pedidoMesa');
        campoMesa.scrollIntoView({ behavior: 'smooth', block: 'center' });
        campoMesa.focus();
        return;
    }
    const boton = document.querySelector('#modalPedido .pedido-acciones .btn-primary');
    if (boton) boton.disabled = true;
    try {
        const pedido = await api('/api/pedidos', {
            metodo: 'POST', sesion: 'staff',
            cuerpo: {
                tipo,
                clienteId: clienteSeleccionadoModal()?.id ?? null,
                mesa: tipo === 'Mesa' ? mesa : '',
                observaciones: document.getElementById('pedidoObservaciones').value.trim(),
                productos: lineasParaApi(pedidoModal)
            }
        });
        reemplazarPedido(pedido);
        pedidoModal = [];
        cerrarModal('modalPedido');
        renderizarTablaPedidos();
        if (esAdministradorActual()) renderizarTablaPedidosDashboard();
        actualizarDashboard();
        mostrarNotificacion(`Pedido ${pedido.codigo} registrado. Los ingredientes ya se descontaron del inventario.`);
        await Promise.allSettled([recargarIngredientes(), recargarMovimientos(), cargarCatalogo({ silencioso: true })]);
        renderizarTablaInventario();
    } catch (error) {
        mostrarNotificacion(error.message, 'error');
        cargarCatalogo({ silencioso: true });
    } finally {
        if (boton) boton.disabled = false;
    }
}

/* ===================================================================
   REPORTES (todo se calcula en el servidor desde PostgreSQL)
   =================================================================== */

let secuenciaReporte = 0;

function obtenerRangoGlobalReportes() {
    const hoy = new Date();
    const hoyClave = fechaLocalISO(hoy);
    const periodo = document.getElementById('reportePeriodoGlobal')?.value || 'mes';
    let desde = '';
    let hasta = hoyClave;
    const restarDias = dias => {
        const fecha = new Date(hoy);
        fecha.setDate(fecha.getDate() - dias);
        return fechaLocalISO(fecha);
    };
    if (periodo === 'hoy') desde = hoyClave;
    else if (periodo === 'semana') desde = restarDias(6);
    else if (periodo === '30dias') desde = restarDias(29);
    else if (periodo === 'mes') desde = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-01`;
    else if (periodo === 'mesAnterior') {
        desde = fechaLocalISO(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1));
        hasta = fechaLocalISO(new Date(hoy.getFullYear(), hoy.getMonth(), 0));
    } else if (periodo === 'rango') {
        desde = document.getElementById('reporteGlobalDesde')?.value || '';
        hasta = document.getElementById('reporteGlobalHasta')?.value || hoyClave;
    }
    return { desde, hasta };
}

async function cargarReporte() {
    if (!esAdministradorActual()) return;
    const secuencia = ++secuenciaReporte;
    const { desde, hasta } = obtenerRangoGlobalReportes();
    const estado = document.getElementById('reporteConexionEstado');
    estado.textContent = 'Consultando información de PostgreSQL...';
    try {
        const reporte = await api('/api/reportes', { sesion: 'staff', parametros: { desde, hasta } });
        if (secuencia !== secuenciaReporte) return; // llegó una respuesta más nueva
        Datos.reporte = reporte;
        estado.textContent = `Datos reales de PostgreSQL · ${reporte.periodo.desde} al ${reporte.periodo.hasta} (horario de Colombia)`;
        renderizarReporte();
    } catch (error) {
        if (secuencia !== secuenciaReporte) return;
        Datos.reporte = null;
        estado.textContent = `No se pudo cargar el reporte: ${error.message}`;
        console.error('No se pudo consultar el reporte:', error);
    }
}

function crearGraficoReporte(canvasId, etiquetas, seriePedidos, serieVentas) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;
    if (canvas._chart) canvas._chart.destroy();
    const movil = window.matchMedia('(max-width: 600px)').matches;
    canvas._chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: etiquetas,
            datasets: [
                { label: 'Pedidos', data: seriePedidos, backgroundColor: '#D81E18', borderRadius: 6, yAxisID: 'yPedidos' },
                { label: 'Ingresos', data: serieVentas, backgroundColor: 'rgba(216,30,24,.38)', borderColor: '#D81E18', borderWidth: 1, borderRadius: 6, yAxisID: 'yVentas' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { legend: { display: !movil, position: 'bottom' } },
            scales: {
                yPedidos: { beginAtZero: true, position: 'left', title: { display: !movil, text: 'Pedidos' }, grid: { color: '#F4F4F4' } },
                yVentas: { beginAtZero: true, position: 'right', title: { display: !movil, text: 'Ingresos' }, grid: { display: false } },
                x: { ticks: { maxRotation: movil ? 45 : 0, autoSkip: true, maxTicksLimit: movil ? 7 : 12 } }
            }
        }
    });
}

function renderizarReporte() {
    const r = Datos.reporte;
    if (!r) return;
    const ind = r.indicadores || {};
    const texto = (id, valor) => { document.getElementById(id).textContent = valor; };

    texto('reportePeriodoAnalisis', `Indicadores del ${r.periodo.desde} al ${r.periodo.hasta}.`);
    texto('reporteIndicadorTotalVentas', formatearCOP(ind.totalVentas));
    texto('reporteIndicadorPedidos', String(ind.pedidosRealizados || 0));
    texto('reporteIndicadorCompletados', String(ind.pedidosCompletados || 0));
    texto('reporteTicketPromedio', formatearCOP(ind.ticketPromedio));
    texto('reporteVentasVariacion', ind.variacionPorcentaje == null ? '—' : `${ind.variacionPorcentaje >= 0 ? '+' : ''}${Number(ind.variacionPorcentaje).toFixed(1)}%`);
    texto('reporteVentasVariacionDetalle', ind.variacionPorcentaje == null
        ? 'No hay ventas base en el período anterior.'
        : `${formatearCOP(ind.totalVentasAnterior)} en el período anterior.`);

    const cliente = (r.clientes || [])[0];
    texto('reporteClientePrincipal', cliente?.nombre || '—');
    texto('reporteClientePrincipalDetalle', cliente ? `${cliente.pedidos} compra(s) · ${formatearCOP(cliente.total)}` : 'Sin compras identificadas en el período.');
    const criticos = (r.inventario || []).filter(i => i.activo && Number(i.existencia) <= Number(i.minimo));
    texto('reporteInventarioCritico', String(criticos.length));

    const mejorDia = ind.diaMayorVentas;
    const peorDia = r.diaMenorMovimiento;
    const mejorHora = ind.horarioMayorActividad;
    texto('reporteDiaResumen', mejorDia ? `Mayor ingreso: ${mejorDia.nombre} (${formatearCOP(mejorDia.ventas)}).${peorDia ? ` Menor movimiento: ${peorDia.nombre}.` : ''}` : 'No hay datos suficientes por día.');
    texto('reporteHoraResumen', mejorHora ? `Mayor actividad: ${mejorHora.hora} con ${mejorHora.pedidos} pedido(s).` : 'No hay datos suficientes por horario.');
    const dias = r.ventasPorDia || [];
    crearGraficoReporte('reporteDiaChart', dias.map(x => x.nombre), dias.map(x => x.pedidos), dias.map(x => x.ventas));
    const horas = (r.ventasPorHora || []).filter(x => x.pedidos > 0 || x.ventas > 0);
    crearGraficoReporte('reporteHoraChart', horas.map(x => x.hora), horas.map(x => x.pedidos), horas.map(x => x.ventas));

    const producto = ind.productoMasVendido;
    const pizza = ind.pizzaMasVendida;
    const pizzaMenos = ind.pizzaMenosVendida;
    const modalidad = (r.modalidades || [])[0];
    texto('reporteProductoDestacado', producto?.nombre || '—');
    texto('reporteProductoDetalle', producto ? `${producto.cantidad} unidades · ${formatearCOP(producto.ingresos)}` : 'Sin ventas pagadas.');
    texto('reportePizzaMasVendida', pizza?.nombre || '—');
    texto('reportePizzaDetalle', pizza ? `${pizza.cantidad} unidades · ${pizza.tamano || 'Tamaño no registrado'}` : 'Sin ventas pagadas.');
    texto('reportePizzaMenosVendida', pizzaMenos?.nombre || '—');
    texto('reportePizzaMenosDetalle', pizzaMenos ? `${pizzaMenos.cantidad} unidades · ${pizzaMenos.tamano || 'Tamaño no registrado'}` : 'Se necesitan al menos dos sabores vendidos.');
    texto('reporteClientePrincipalApi', cliente?.nombre || '—');
    texto('reporteClientePrincipalApiDetalle', cliente ? `${cliente.pedidos} pedido(s) · ${formatearCOP(cliente.total)}` : 'Sin clientes asociados.');
    texto('reporteModalidadPrincipal', modalidad?.modalidad || '—');
    texto('reporteModalidadDetalle', modalidad ? `${modalidad.pedidos} pedido(s)` : 'Sin pedidos.');
    document.getElementById('reporteProductosTabla').innerHTML = (r.productos || []).map(i =>
        `<tr><td>${escaparHTML(i.nombre)}</td><td>${escaparHTML(i.categoria || '—')}</td><td>${escaparHTML(i.tamano || '—')}</td><td>${i.cantidad}</td><td>${formatearCOP(i.ingresos)}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="tabla-vacia">No hay productos vendidos y pagados en el período.</td></tr>';

    renderizarRecomendaciones(r, criticos);
    renderizarReporteVentas();
    renderizarReporteInventario();
    renderizarReporteClientes();
}

function renderizarRecomendaciones(r, criticos) {
    const ind = r.indicadores || {};
    const variacion = ind.variacionPorcentaje;
    const principal = (r.clientes || [])[0];
    const top = (r.productos || [])[0];
    const items = [
        {
            titulo: 'Inventario',
            texto: criticos.length
                ? `Reponer ${criticos.length} artículo(s) crítico(s): ${criticos.slice(0, 3).map(i => i.nombre).join(', ')}${criticos.length > 3 ? '…' : '.'}`
                : 'El inventario está estable; mantener la frecuencia actual de revisión.'
        },
        {
            titulo: 'Ventas',
            texto: (r.ventasDetalle || []).length
                ? `${variacion != null && variacion < 0 ? 'Las ventas bajaron respecto al período anterior.' : 'Mantener las estrategias actuales.'} El ticket promedio es ${formatearCOP(ind.ticketPromedio)}.`
                : 'Aún no hay ventas en el período seleccionado para tomar decisiones comerciales.'
        },
        {
            titulo: 'Producto y cliente',
            texto: top
                ? `Impulsar ${top.nombre}${principal ? ` y activar una campaña especial para ${principal.nombre}.` : '.'}`
                : principal ? `Mantener seguimiento cercano de ${principal.nombre}.` : 'Registra clientes para mejorar el análisis de fidelidad.'
        }
    ];
    document.getElementById('reporteRecomendaciones').innerHTML = items.map(i =>
        `<article class="reporte-recomendacion"><strong>${escaparHTML(i.titulo)}</strong>${escaparHTML(i.texto)}</article>`).join('');
}

function ventaPorCodigo(codigo) {
    return Datos.ventas.find(v => v.codigo === codigo);
}

function renderizarReporteVentas() {
    const r = Datos.reporte;
    if (!r || !esAdministradorActual()) return;
    const ventas = r.ventasDetalle || [];
    const total = Number(r.indicadores?.totalVentas || 0);
    document.getElementById('reporteVentasTotal').textContent = formatearCOP(total);
    document.getElementById('reporteVentasCantidad').textContent = String(ventas.length);
    document.getElementById('reporteVentasPromedio').textContent = formatearCOP(ventas.length ? total / ventas.length : 0);
    document.getElementById('reporteVentasVacio').hidden = ventas.length > 0;
    document.getElementById('reporteVentasTabla').innerHTML = ventas.map(v => `<tr>
        <td>${escaparHTML(v.codigo)}</td><td>${escaparHTML(formatearFechaComercial(v.fecha))}</td>
        <td>${escaparHTML(v.cliente)}</td><td>${escaparHTML(v.productos)}</td>
        <td>${formatearCOP(v.total)}</td>
        <td><button class="accion-btn accion-ver" data-reporte-venta="${escaparHTML(v.codigo)}">Ver detalle</button></td>
    </tr>`).join('');
    document.querySelectorAll('[data-reporte-venta]').forEach(b => b.addEventListener('click', () => {
        const venta = ventaPorCodigo(b.dataset.reporteVenta);
        if (venta) mostrarDetalleComercial('venta', venta.id);
        else mostrarNotificacion('Esa venta no está entre las más recientes cargadas. Búscala en el módulo de ventas.', 'error');
    }));
    const masVendidos = (r.productos || []).slice(0, 5);
    document.getElementById('reporteProductosMasVendidos').innerHTML = masVendidos.length
        ? `<h4>Productos más vendidos</h4><ol>${masVendidos.map(i => `<li>${escaparHTML(i.nombre)}${i.tamano ? ` · ${escaparHTML(i.tamano)}` : ''}<strong>${i.cantidad}</strong></li>`).join('')}</ol>`
        : '<p class="reporte-nota">Aún no hay ventas para este periodo.</p>';
    actualizarGraficoVentas('reporteVentasChart', 'reporteVentasGraficoVacio', ventas.map(v => ({ fecha: v.fecha, total: v.total })), 10);
}

function inventarioFiltradoReporte() {
    const r = Datos.reporte;
    if (!r) return [];
    const categoria = document.getElementById('reporteInventarioCategoria')?.value || '';
    const estado = document.getElementById('reporteInventarioEstado')?.value || '';
    return (r.inventario || []).map(i => ({ ...i, cantidad: Number(i.existencia), minimo: Number(i.minimo) }))
        .filter(i => (!categoria || i.categoria === categoria) && (!estado || estadoInventario(i) === estado));
}

function renderizarReporteInventario() {
    const r = Datos.reporte;
    if (!r || !esAdministradorActual()) return;
    const todos = r.inventario || [];
    const selector = document.getElementById('reporteInventarioCategoria');
    const previa = selector.value;
    const categorias = [...new Set(todos.map(i => i.categoria || 'Otros'))].sort();
    selector.innerHTML = '<option value="">Todas las categorías</option>' + categorias.map(c => `<option value="${escaparHTML(c)}">${escaparHTML(c)}</option>`).join('');
    if (categorias.includes(previa)) selector.value = previa;

    const inventario = inventarioFiltradoReporte();
    document.getElementById('reporteInventarioVacio').hidden = inventario.length > 0;
    document.getElementById('reporteInventarioTabla').innerHTML = inventario.map(i => `<tr>
        <td>${escaparHTML(i.nombre)}</td><td>${escaparHTML(i.categoria || 'Otros')}</td>
        <td>${formatearCantidad(i.cantidad)} ${escaparHTML(i.unidad)}</td><td>${escaparHTML(i.unidad || '—')}</td>
        <td>${formatearCantidad(i.minimo)} ${escaparHTML(i.unidad)}</td><td>${badgeEstado(estadoInventario(i))}</td>
    </tr>`).join('');
    const activos = inventario.filter(i => i.activo);
    document.getElementById('reporteInventarioResumen').innerHTML =
        `<span>Registros filtrados: <strong>${inventario.length}</strong></span><span>Stock bajo: <strong>${activos.filter(i => i.cantidad > 0 && i.cantidad <= i.minimo).length}</strong></span><span>Agotados: <strong>${activos.filter(i => i.cantidad <= 0).length}</strong></span><span>Consumo por pedidos en el período: <strong>${activos.filter(i => i.consumo > 0).length}</strong> artículo(s)</span>`;

    const nombres = new Set(inventario.map(i => i.nombre));
    const movimientos = (r.movimientos || []).filter(m => nombres.has(m.ingrediente));
    document.getElementById('reporteMovimientosVacio').hidden = movimientos.length > 0;
    document.getElementById('reporteMovimientosTabla').innerHTML = movimientos.map(m =>
        `<tr><td>${escaparHTML(formatearFechaComercial(m.fecha))}</td><td>${escaparHTML(m.ingrediente)}</td><td>${badgeEstado(m.tipo)}</td><td>${formatearCantidad(Math.abs(m.cantidad))} ${escaparHTML(m.unidad)}</td><td>${escaparHTML(m.motivo || '—')}</td></tr>`
    ).join('');
}

function clientesFiltradosReporte() {
    const r = Datos.reporte;
    if (!r) return [];
    const busqueda = (document.getElementById('reporteClientesBusqueda')?.value || '').trim().toLowerCase();
    return (r.clientes || []).filter(c => `${c.nombre} ${c.correo}`.toLowerCase().includes(busqueda));
}

function renderizarReporteClientes() {
    const r = Datos.reporte;
    if (!r || !esAdministradorActual()) return;
    const resultados = clientesFiltradosReporte();
    const busqueda = (document.getElementById('reporteClientesBusqueda')?.value || '').trim();
    document.getElementById('reporteClientesTotal').textContent = String(r.clientesRegistrados || 0);
    document.getElementById('reporteClientesNuevos').textContent = `${r.clientesNuevos || 0} cliente(s) nuevo(s) registrados en el período.`;
    document.getElementById('reporteClientesTabla').innerHTML = resultados.map(c => `<tr>
        <td>${escaparHTML(c.nombre)}</td><td>${escaparHTML(c.correo || '—')}</td><td>${c.pedidos}</td><td>${formatearCOP(c.total)}</td></tr>`).join('');
    const vacio = document.getElementById('reporteClientesVacio');
    vacio.hidden = resultados.length > 0;
    vacio.textContent = busqueda ? 'No hay clientes que coincidan con la búsqueda.' : 'Ningún cliente registrado compró en este período.';
    const conCliente = (r.clientes || []).reduce((s, c) => s + c.pedidos, 0);
    document.getElementById('reporteVentasSinCliente').textContent = `${Math.max(0, (r.ventasDetalle || []).length - conCliente)} venta(s) sin cliente registrado asociado.`;
}

function exportarReporteCSV(tipo) {
    if (!exigirAdministrador('exportar reportes')) return;
    const r = Datos.reporte;
    if (!r) {
        mostrarNotificacion('Primero carga el reporte desde la base de datos.', 'error');
        return;
    }
    const encabezados = {
        ventas: ['Código', 'Fecha', 'Cliente', 'Productos', 'Total'],
        inventario: ['Artículo', 'Categoría', 'Existencia', 'Unidad', 'Stock mínimo', 'Estado'],
        clientes: ['Nombre', 'Correo', 'Compras', 'Total comprado']
    }[tipo];
    if (!encabezados) return;
    const filas = tipo === 'ventas'
        ? (r.ventasDetalle || []).map(v => [v.codigo, formatearFechaComercial(v.fecha), v.cliente, v.productos, v.total])
        : tipo === 'inventario'
            ? inventarioFiltradoReporte().map(i => [i.nombre, i.categoria, i.cantidad, i.unidad, i.minimo, estadoInventario(i)])
            : clientesFiltradosReporte().map(c => [c.nombre, c.correo || '', c.pedidos, c.total]);
    // Evita inyección de fórmulas al abrir el CSV en una hoja de cálculo.
    const protegerCelda = valor => {
        const texto = String(valor ?? '');
        return `"${(/^[\s]*[=+\-@]/.test(texto) ? `'${texto}` : texto).replace(/"/g, '""')}"`;
    };
    const csv = [encabezados, ...filas].map(fila => fila.map(protegerCelda).join(',')).join('\r\n');
    const enlace = document.createElement('a');
    const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    enlace.href = url;
    enlace.download = `reporte-${tipo}-${fechaLocalISO()}.csv`;
    enlace.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ===================================================================
   ARRANQUE (un único registro de temporizadores y listeners)
   =================================================================== */

document.addEventListener('DOMContentLoaded', async () => {
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.addEventListener('click', evento => {
            if (evento.target === modal) cerrarModal(modal.id);
        });
    });
    document.addEventListener('keydown', evento => {
        if (evento.key === 'Escape') cerrarMenuLateral();
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) cerrarMenuLateral();
    });

    ['filtroPedidosFecha', 'filtroPedidosCliente', 'filtroPedidosEstado'].forEach(id => {
        document.getElementById(id).addEventListener('input', renderizarTablaPedidos);
        document.getElementById(id).addEventListener('change', renderizarTablaPedidos);
    });
    document.getElementById('btnBuscarPedidos')?.addEventListener('click', renderizarTablaPedidos);
    document.getElementById('filtroPedidosCliente').addEventListener('keydown', e => {
        if (e.key === 'Enter') renderizarTablaPedidos();
    });
    ['filtroVentasFecha', 'filtroVentasCliente', 'filtroVentasEstado'].forEach(id => {
        document.getElementById(id).addEventListener('input', renderizarTablaVentas);
        document.getElementById(id).addEventListener('change', renderizarTablaVentas);
    });

    const periodoGlobal = document.getElementById('reportePeriodoGlobal');
    const desdeGlobal = document.getElementById('reporteGlobalDesde');
    const hastaGlobal = document.getElementById('reporteGlobalHasta');
    const actualizarPeriodoGlobal = () => {
        const personalizado = periodoGlobal.value === 'rango';
        desdeGlobal.disabled = !personalizado;
        hastaGlobal.disabled = !personalizado;
        if (personalizado && !desdeGlobal.value) desdeGlobal.value = obtenerRangoGlobalReportes().hasta;
        cargarReporte();
    };
    periodoGlobal.addEventListener('change', actualizarPeriodoGlobal);
    desdeGlobal.addEventListener('change', actualizarPeriodoGlobal);
    hastaGlobal.addEventListener('change', actualizarPeriodoGlobal);
    document.getElementById('reporteInventarioCategoria').addEventListener('change', renderizarReporteInventario);
    document.getElementById('reporteInventarioEstado').addEventListener('change', renderizarReporteInventario);
    document.getElementById('reporteClientesBusqueda').addEventListener('input', renderizarReporteClientes);
    document.getElementById('dashboardPeriodoVentas').addEventListener('change', actualizarDashboard);

    // Actualizaciones periódicas: se registran UNA sola vez aquí (antes se duplicaban al guardar cada promoción).
    window.setInterval(() => {
        if (document.visibilityState === 'visible' && document.getElementById('vistaCliente').classList.contains('activa')) {
            cargarCatalogo({ silencioso: true });
        }
    }, REFRESCO_CATALOGO_MS);
    window.setInterval(refrescarPanelPeriodicamente, REFRESCO_PANEL_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (document.getElementById('vistaCliente').classList.contains('activa')) cargarCatalogo({ silencioso: true });
        else refrescarPanelPeriodicamente();
    });

    actualizarEtiquetaDescuento();
    actualizarEtiquetaMovimiento();
    renderizarPedidoCliente();
    await restaurarSesionCliente();
    await actualizarSesionCliente();
    await cargarCatalogo();
    await restaurarSesionStaff();
});


/* Etiquetas de columna para la vista de tarjetas apiladas en móvil (CSS usa data-etiqueta). */
function etiquetarCeldasTablas() {
    document.querySelectorAll('.tabla-contenedor table.tabla').forEach(tabla => {
        const titulos = [...tabla.querySelectorAll('thead th')].map(th => th.textContent.trim());
        tabla.querySelectorAll('tbody tr').forEach(fila => {
            [...fila.children].forEach((celda, i) => {
                if (celda.tagName === 'TD' && celda.colSpan === 1 && titulos[i] && celda.dataset.etiqueta !== titulos[i]) celda.dataset.etiqueta = titulos[i];
            });
        });
    });
}
new MutationObserver(() => etiquetarCeldasTablas()).observe(document.body, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', etiquetarCeldasTablas);
