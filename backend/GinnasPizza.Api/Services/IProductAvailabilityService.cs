using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Models;

namespace GinnasPizza.Api.Services;

/// <summary>Unidades de un producto (en un tamaño) que se van a preparar.</summary>
public sealed record LineaConsumo(int ProductoId, string Tamano, int Cantidad);

/// <summary>Cantidad total de un ingrediente (entidad rastreada por el contexto) que consumirá el pedido.</summary>
public sealed record ConsumoIngrediente(Ingrediente Ingrediente, decimal Cantidad);

/// <summary>Resultado de validar recetas y existencias de un conjunto de líneas.</summary>
public sealed record PlanConsumo(bool Ok, string? Error, IReadOnlyList<ConsumoIngrediente> Items)
{
    public static PlanConsumo Falla(string error) => new(false, error, []);
}

public interface IProductAvailabilityService
{
    /// <summary>Disponibilidad por producto y tamaño según recetas e inventario actuales.</summary>
    Task<IReadOnlyList<ProductAvailabilityResponse>> GetAllAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Verifica que cada línea tenga receta válida y que haya existencias suficientes. Devuelve el consumo
    /// por ingrediente usando entidades rastreadas, de modo que el llamador pueda descontarlas en la
    /// misma transacción.
    /// </summary>
    Task<PlanConsumo> PlanificarConsumoAsync(IEnumerable<LineaConsumo> lineas, CancellationToken cancellationToken);
}
