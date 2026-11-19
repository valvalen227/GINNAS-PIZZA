using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Data;
using GinnasPizza.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Services;

public sealed class ProductAvailabilityService(AppDbContext db) : IProductAvailabilityService
{
    public async Task<IReadOnlyList<ProductAvailabilityResponse>> GetAllAsync(CancellationToken cancellationToken)
    {
        var productos = await db.Productos.AsNoTracking().OrderBy(p => p.Id).ToListAsync(cancellationToken);
        var recetas = await db.Recetas.AsNoTracking().Include(r => r.Ingrediente).ToListAsync(cancellationToken);
        var porProductoTamano = recetas.ToLookup(r => (r.ProductoId, r.Tamano));

        var resultado = new List<ProductAvailabilityResponse>();
        foreach (var producto in productos)
        {
            var tamanos = producto.EsPizza ? Tamanos.Pizza : [string.Empty];
            foreach (var tamano in tamanos)
            {
                resultado.Add(Evaluar(producto, tamano, porProductoTamano[(producto.Id, tamano)].ToArray()));
            }
        }
        return resultado;
    }

    private static ProductAvailabilityResponse Evaluar(Producto producto, string tamano, Receta[] receta)
    {
        ProductAvailabilityResponse Respuesta(bool disponible, string estado, string motivo, int? max) =>
            new(producto.Id, tamano, disponible, estado, motivo, max);

        if (!producto.Disponible)
            return Respuesta(false, "unavailable", "Este producto está temporalmente no disponible.", 0);
        if (producto.PrecioPara(tamano) is null)
            return Respuesta(false, "unavailable", "Este tamaño no está disponible.", 0);
        if (receta.Length == 0)
            return Respuesta(false, "not-verifiable", "No hay una receta con inventario configurada para este producto.", null);
        if (receta.Any(r => r.Cantidad <= 0 || r.Ingrediente is null || !r.Ingrediente.Activo))
            return Respuesta(false, "not-verifiable", "La receta contiene ingredientes sin una relación de inventario válida.", null);

        var maximo = receta.Min(r => decimal.Floor(r.Ingrediente!.StockActual / r.Cantidad));
        var acotado = maximo >= int.MaxValue ? int.MaxValue : (int)Math.Max(0, maximo);
        return acotado == 0
            ? Respuesta(false, "unavailable", "No hay existencias suficientes de uno o más ingredientes.", 0)
            : Respuesta(true, "available", $"Hay existencias para un máximo de {acotado} unidad(es).", acotado);
    }

    public async Task<PlanConsumo> PlanificarConsumoAsync(IEnumerable<LineaConsumo> lineas, CancellationToken cancellationToken)
    {
        var agrupadas = lineas
            .GroupBy(l => (l.ProductoId, l.Tamano))
            .Select(g => new LineaConsumo(g.Key.ProductoId, g.Key.Tamano, g.Sum(l => l.Cantidad)))
            .ToList();
        if (agrupadas.Count == 0) return PlanConsumo.Falla("El pedido no contiene productos.");

        var ids = agrupadas.Select(l => l.ProductoId).Distinct().ToList();
        // Consulta con seguimiento: las entidades Ingrediente devueltas se descuentan luego en la misma transacción.
        var recetas = await db.Recetas
            .Include(r => r.Ingrediente)
            .Include(r => r.Producto)
            .Where(r => ids.Contains(r.ProductoId))
            .ToListAsync(cancellationToken);

        var requerido = new Dictionary<int, ConsumoIngrediente>();
        foreach (var linea in agrupadas)
        {
            var receta = recetas.Where(r => r.ProductoId == linea.ProductoId && r.Tamano == linea.Tamano).ToList();
            var nombre = recetas.FirstOrDefault(r => r.ProductoId == linea.ProductoId)?.Producto?.Nombre ?? "El producto";
            var etiqueta = string.IsNullOrEmpty(linea.Tamano) ? nombre : $"{nombre} ({linea.Tamano})";
            if (receta.Count == 0)
                return PlanConsumo.Falla($"{etiqueta} no tiene una receta configurada; no se puede verificar el inventario.");

            foreach (var item in receta)
            {
                if (item.Cantidad <= 0 || item.Ingrediente is null || !item.Ingrediente.Activo)
                    return PlanConsumo.Falla($"La receta de {etiqueta} contiene un ingrediente inactivo o inválido.");
                var cantidad = item.Cantidad * linea.Cantidad;
                requerido[item.IngredienteId] = requerido.TryGetValue(item.IngredienteId, out var actual)
                    ? actual with { Cantidad = actual.Cantidad + cantidad }
                    : new ConsumoIngrediente(item.Ingrediente, cantidad);
            }
        }

        foreach (var consumo in requerido.Values)
        {
            if (consumo.Ingrediente.StockActual < consumo.Cantidad)
                return PlanConsumo.Falla($"No hay existencias suficientes de {consumo.Ingrediente.Nombre} para preparar el pedido.");
        }
        return new PlanConsumo(true, null, requerido.Values.ToList());
    }
}
