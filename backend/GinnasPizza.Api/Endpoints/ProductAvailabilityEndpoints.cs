using GinnasPizza.Api.Contracts;
using GinnasPizza.Api.Services;
using Microsoft.AspNetCore.Http.HttpResults;

namespace GinnasPizza.Api.Endpoints;

public static class ProductAvailabilityEndpoints
{
    public static WebApplication MapProductAvailability(this WebApplication app)
    {
        app.MapGet("/api/productos/disponibilidad", async Task<Ok<IReadOnlyList<ProductAvailabilityResponse>>> (
            IProductAvailabilityService service,
            CancellationToken cancellationToken) =>
        {
            var availability = await service.GetAllAsync(cancellationToken);
            return TypedResults.Ok(availability);
        })
        .WithName("GetProductAvailability")
        .WithSummary("Consultar disponibilidad de productos por tamaño")
        .WithDescription("Calcula la disponibilidad a partir de las recetas por tamaño y el inventario actual. Devuelve unidades máximas, no stock.")
        .Produces<IReadOnlyList<ProductAvailabilityResponse>>(StatusCodes.Status200OK);

        return app;
    }
}
