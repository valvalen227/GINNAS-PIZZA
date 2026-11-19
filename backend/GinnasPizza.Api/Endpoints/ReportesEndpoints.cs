using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Endpoints;

public static class ReportesEndpoints
{
    private static readonly string[] DiasSemana = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

    public static WebApplication MapReportes(this WebApplication app)
    {
        app.MapGet("/api/reportes", async (string? desde, string? hasta, AppDbContext db, CancellationToken ct) =>
        {
            // El período se interpreta en días calendario de Colombia (UTC-5) y se convierte a UTC para consultar.
            var hastaDia = TiempoColombia.TryParseDia(hasta, out var h) ? h : TiempoColombia.Hoy();
            var desdeDia = TiempoColombia.TryParseDia(desde, out var d) ? d : hastaDia.AddDays(-29);
            if (desdeDia > hastaDia) (desdeDia, hastaDia) = (hastaDia, desdeDia);

            var inicio = TiempoColombia.InicioDiaUtc(desdeDia);
            var fin = TiempoColombia.FinDiaUtc(hastaDia);
            var dias = hastaDia.DayNumber - desdeDia.DayNumber + 1;
            var inicioAnterior = TiempoColombia.InicioDiaUtc(desdeDia.AddDays(-dias));
            var finAnterior = inicio.AddTicks(-1);

            var pedidos = await db.Pedidos.AsNoTracking()
                .Where(p => p.Fecha >= inicio && p.Fecha <= fin && p.Estado != EstadosPedido.Cancelado)
                .ToListAsync(ct);
            var ventas = await db.Ventas.AsNoTracking()
                .Include(v => v.Pedido).ThenInclude(p => p!.Cliente)
                .Include(v => v.Pedido).ThenInclude(p => p!.Detalles).ThenInclude(x => x.Producto)
                .Where(v => v.Fecha >= inicio && v.Fecha <= fin)
                .OrderByDescending(v => v.Fecha)
                .ToListAsync(ct);

            var totalVentas = ventas.Sum(v => v.Total);
            var totalAnterior = await db.Ventas.AsNoTracking()
                .Where(v => v.Fecha >= inicioAnterior && v.Fecha <= finAnterior)
                .SumAsync(v => (decimal?)v.Total, ct) ?? 0m;
            decimal? variacion = totalAnterior == 0 ? null : (totalVentas - totalAnterior) / totalAnterior * 100;
            var completados = pedidos.Count(p => p.Estado == EstadosPedido.Entregado);

            var porDia = Enumerable.Range(0, 7).Select(indice => new
            {
                nombre = DiasSemana[indice],
                pedidos = pedidos.Count(p => (int)TiempoColombia.ALocal(p.Fecha).DayOfWeek == indice),
                ventas = ventas.Where(v => (int)TiempoColombia.ALocal(v.Fecha).DayOfWeek == indice).Sum(v => v.Total)
            }).ToList();

            var porHora = Enumerable.Range(0, 24).Select(hora => new
            {
                hora = $"{hora:00}:00",
                pedidos = pedidos.Count(p => TiempoColombia.ALocal(p.Fecha).Hour == hora),
                ventas = ventas.Where(v => TiempoColombia.ALocal(v.Fecha).Hour == hora).Sum(v => v.Total)
            }).ToList();

            var lineas = ventas.SelectMany(v => v.Pedido!.Detalles).ToList();
            var porProducto = lineas
                .GroupBy(l => new { l.ProductoId, l.PromocionId, l.Nombre, Categoria = l.Producto?.Categoria ?? "Combos", l.Tamano })
                .Select(g => new
                {
                    nombre = g.Key.Nombre,
                    categoria = g.Key.Categoria,
                    tamano = g.Key.Tamano,
                    cantidad = g.Sum(l => l.Cantidad),
                    ingresos = g.Sum(l => l.Subtotal)
                })
                .OrderByDescending(x => x.cantidad).ThenByDescending(x => x.ingresos)
                .ToList();

            // Rankings de pizzas agregados por sabor (suma de todos los tamaños).
            var pizzas = porProducto.Where(p => p.categoria == Categorias.Pizzas)
                .GroupBy(p => p.nombre)
                .Select(g => new
                {
                    nombre = g.Key,
                    categoria = Categorias.Pizzas,
                    tamano = string.Join(", ", g.Select(x => x.tamano).Distinct()),
                    cantidad = g.Sum(x => x.cantidad),
                    ingresos = g.Sum(x => x.ingresos)
                })
                .OrderByDescending(x => x.cantidad).ToList();
            var bebidas = porProducto.Where(p => p.categoria == Categorias.Bebidas).ToList();

            var porCliente = ventas
                .Where(v => v.Pedido!.Cliente is not null)
                .GroupBy(v => v.Pedido!.ClienteId)
                .Select(g => new
                {
                    nombre = g.First().Pedido!.Cliente!.Nombre,
                    correo = g.First().Pedido!.Cliente!.Correo,
                    pedidos = g.Count(),
                    total = g.Sum(v => v.Total)
                })
                .OrderByDescending(x => x.total).ToList();

            var modalidades = pedidos
                .GroupBy(p => string.IsNullOrWhiteSpace(p.TipoPedido) ? "No informado" : p.TipoPedido)
                .Select(g => new { modalidad = g.Key, pedidos = g.Count() })
                .OrderByDescending(x => x.pedidos).ToList();

            var movimientos = await db.MovimientosInventario.AsNoTracking().Include(m => m.Ingrediente)
                .Where(m => m.Fecha >= inicio && m.Fecha <= fin)
                .OrderByDescending(m => m.Fecha).ThenByDescending(m => m.Id)
                .Take(500).ToListAsync(ct);
            var ingredientes = await db.Ingredientes.AsNoTracking().OrderBy(i => i.StockActual).ToListAsync(ct);

            // Consumo real por pedidos en el período: salidas menos devoluciones por cancelación.
            var consumoPorIngrediente = await db.MovimientosInventario.AsNoTracking()
                .Where(m => m.Fecha >= inicio && m.Fecha <= fin && m.PedidoId != null)
                .GroupBy(m => m.IngredienteId)
                .Select(g => new { g.Key, Consumo = g.Sum(m => m.Tipo == "Salida" ? m.Cantidad : m.Tipo == "Entrada" ? -m.Cantidad : 0m) })
                .ToDictionaryAsync(x => x.Key, x => x.Consumo, ct);

            var inventario = ingredientes.Select(i => new
            {
                id = i.Id,
                nombre = i.Nombre,
                categoria = i.Categoria,
                unidad = i.UnidadMedida,
                existencia = i.StockActual,
                minimo = i.StockMinimo,
                activo = i.Activo,
                consumo = consumoPorIngrediente.TryGetValue(i.Id, out var usado) ? usado : 0m
            }).ToList();

            var clientesRegistrados = await db.Clientes.CountAsync(c => c.Activo, ct);
            var clientesNuevos = await db.Clientes.CountAsync(c => c.FechaRegistro >= inicio && c.FechaRegistro <= fin, ct);

            var mejorDia = porDia.Where(x => x.ventas > 0).OrderByDescending(x => x.ventas).FirstOrDefault();
            var menorDia = porDia.Where(x => x.pedidos > 0 || x.ventas > 0).OrderBy(x => x.ventas).ThenBy(x => x.pedidos).FirstOrDefault();
            var mejorHora = porHora.Where(x => x.pedidos > 0).OrderByDescending(x => x.pedidos).FirstOrDefault();

            return Results.Ok(new
            {
                periodo = new { desde = desdeDia.ToString("yyyy-MM-dd"), hasta = hastaDia.ToString("yyyy-MM-dd") },
                ventasDetalle = ventas.Select(v => new
                {
                    codigo = $"#V-{v.PedidoId}",
                    fecha = v.Fecha,
                    cliente = v.Pedido!.Cliente?.Nombre ?? (string.IsNullOrWhiteSpace(v.Pedido.NombreCliente) ? "Sin cliente registrado" : v.Pedido.NombreCliente),
                    correo = v.Pedido.Cliente?.Correo ?? v.Pedido.CorreoCliente,
                    productos = string.Join("; ", v.Pedido.Detalles.Select(l =>
                        $"{l.Nombre}{(string.IsNullOrWhiteSpace(l.Tamano) ? "" : $" · {l.Tamano}")} x{l.Cantidad}")),
                    total = v.Total
                }).ToList(),
                indicadores = new
                {
                    totalVentas,
                    pedidosRealizados = pedidos.Count,
                    pedidosCompletados = completados,
                    ticketPromedio = ventas.Count == 0 ? 0m : totalVentas / ventas.Count,
                    variacionPorcentaje = variacion,
                    totalVentasAnterior = totalAnterior,
                    productoMasVendido = porProducto.FirstOrDefault(),
                    pizzaMasVendida = pizzas.FirstOrDefault(),
                    pizzaMenosVendida = pizzas.Count > 1 ? pizzas.LastOrDefault() : null,
                    diaMayorVentas = mejorDia,
                    horarioMayorActividad = mejorHora
                },
                ventasPorDia = porDia,
                ventasPorHora = porHora,
                productos = porProducto,
                bebidas,
                clientes = porCliente,
                clientesRegistrados,
                clientesNuevos,
                modalidades,
                inventario,
                movimientos = movimientos.Select(m => new
                {
                    fecha = m.Fecha,
                    ingrediente = m.Ingrediente?.Nombre ?? "Registro sin ingrediente",
                    unidad = m.Ingrediente?.UnidadMedida ?? "",
                    tipo = m.Tipo,
                    cantidad = m.Cantidad,
                    motivo = m.Motivo
                }).ToList(),
                diaMenorMovimiento = menorDia
            });
        })
        .RequireRoles(Roles.Administrador)
        .WithName("Reportes");

        return app;
    }
}
