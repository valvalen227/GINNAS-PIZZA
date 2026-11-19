/* =====================================================================
 * Paginación reutilizable para tablas (client-side)
 * ---------------------------------------------------------------------
 * No requiere tocar las funciones que renderizan cada tabla: observa el
 * <tbody> y, cada vez que se vuelve a dibujar, muestra solo las filas de
 * la página actual y renderiza el paginador debajo de la tabla.
 *
 * Uso:  Paginador.registrar('tablaPedidos');
 *       Paginador.registrar('tablaClientes', { tamano: 20 });
 * ===================================================================== */
const Paginador = (() => {
    const TAMANOS = [5, 10, 20, 50];
    const instancias = new Map();

    const esFilaVacia = fila => !!fila.querySelector('td[colspan], .tabla-vacia');

    function crear(tbody, opciones = {}) {
        const estado = { pagina: 1, tamano: opciones.tamano || 10 };
        const contenedor = tbody.closest('.tabla-wrapper') || tbody.closest('table');
        const barra = document.createElement('nav');
        barra.className = 'paginador';
        barra.setAttribute('aria-label', 'Paginación de la tabla');
        contenedor.insertAdjacentElement('afterend', barra);

        function aplicar() {
            const filas = [...tbody.children].filter(f => f.tagName === 'TR');
            const vacia = filas.length === 0 || (filas.length === 1 && esFilaVacia(filas[0]));
            const total = vacia ? 0 : filas.length;
            const paginas = Math.max(1, Math.ceil(total / estado.tamano));
            estado.pagina = Math.min(Math.max(1, estado.pagina), paginas);
            const inicio = (estado.pagina - 1) * estado.tamano;
            const fin = inicio + estado.tamano;

            filas.forEach((fila, i) => { fila.hidden = !vacia && (i < inicio || i >= fin); });
            barra.hidden = total === 0;
            if (total) dibujar(total, paginas, inicio, Math.min(fin, total));
        }

        function ventanaPaginas(actual, total) {
            if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
            const set = new Set([1, total, actual, actual - 1, actual + 1]);
            if (actual <= 3) [2, 3, 4].forEach(n => set.add(n));
            if (actual >= total - 2) [total - 1, total - 2, total - 3].forEach(n => set.add(n));
            const orden = [...set].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
            const res = [];
            orden.forEach((n, i) => {
                if (i && n - orden[i - 1] > 1) res.push('…');
                res.push(n);
            });
            return res;
        }

        function dibujar(total, paginas, inicio, fin) {
            const botones = ventanaPaginas(estado.pagina, paginas).map(n => n === '…'
                ? '<span class="paginador-puntos" aria-hidden="true">…</span>'
                : `<button type="button" class="paginador-btn${n === estado.pagina ? ' activo' : ''}" data-pag="${n}" ${n === estado.pagina ? 'aria-current="page"' : ''}>${n}</button>`).join('');
            barra.innerHTML = `
                <div class="paginador-tamano">
                    <label>Mostrar
                        <select class="paginador-select" aria-label="Registros por página">
                            ${TAMANOS.map(t => `<option value="${t}"${t === estado.tamano ? ' selected' : ''}>${t}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="paginador-info" aria-live="polite">Mostrando ${inicio + 1} a ${fin} de ${total} registros</div>
                <div class="paginador-nav">
                    <button type="button" class="paginador-btn paginador-nav-btn" data-pag="${estado.pagina - 1}" ${estado.pagina === 1 ? 'disabled' : ''}>Anterior</button>
                    ${botones}
                    <button type="button" class="paginador-btn paginador-nav-btn" data-pag="${estado.pagina + 1}" ${estado.pagina === paginas ? 'disabled' : ''}>Siguiente</button>
                </div>`;
        }

        barra.addEventListener('click', e => {
            const btn = e.target.closest('[data-pag]');
            if (!btn || btn.disabled) return;
            estado.pagina = Number(btn.dataset.pag);
            aplicar();
        });
        barra.addEventListener('change', e => {
            if (!e.target.matches('.paginador-select')) return;
            estado.tamano = Number(e.target.value);
            estado.pagina = 1;
            aplicar();
        });

        // Se vuelve a paginar cada vez que la tabla se re-renderiza.
        new MutationObserver(aplicar).observe(tbody, { childList: true });
        aplicar();
        return { estado, aplicar };
    }

    function registrar(idTbody, opciones) {
        const tbody = document.getElementById(idTbody);
        if (!tbody || instancias.has(idTbody)) return;
        instancias.set(idTbody, crear(tbody, opciones));
    }

    // Al cambiar un filtro, vuelve a la primera página de ese módulo.
    // Captura = se ejecuta antes que el render disparado por el propio filtro.
    function reiniciarAlFiltrar(evento) {
        if (!evento.target.closest('.filtros-comerciales, .reporte-filtros, .reporte-global-filtros, [type="search"]')) return;
        const modulo = evento.target.closest('.modulo-admin');
        if (!modulo) return;
        instancias.forEach((inst, id) => {
            if (modulo.contains(document.getElementById(id))) inst.estado.pagina = 1;
        });
    }
    ['input', 'change', 'click'].forEach(tipo => document.addEventListener(tipo, reiniciarAlFiltrar, true));

    const TABLAS = [
        'tablaPedidos', 'tablaPedidosCobro', 'tablaVentas',
        'tablaInventario', 'tablaMovimientos', 'tablaProductos', 'tablaPromociones',
        'tablaClientes', 'tablaProveedores', 'tablaUsuarios',
        'reporteProductosTabla', 'reporteVentasTabla', 'reporteInventarioTabla',
        'reporteMovimientosTabla', 'reporteClientesTabla'
    ];
    const iniciar = () => TABLAS.forEach(id => registrar(id));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();

    return { registrar };
})();
