using GinnasPizza.Api.Data;
using GinnasPizza.Api.Endpoints;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// ── CORS ──
// Desarrollo: abierto (AllowAnyOrigin/Header/Method) para que el fetch funcione desde cualquier puerto o file://.
// Otros entornos: solo los orígenes listados en Cors:Origins.
builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
    {
        if (builder.Environment.IsDevelopment())
        {
            policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod();
        }
        else
        {
            var origenes = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
            policy.WithOrigins(origenes).AllowAnyHeader().AllowAnyMethod();
        }
    });
});

// ── PostgreSQL ──
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddOpenApi();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddScoped<IProductAvailabilityService, ProductAvailabilityService>();
builder.Services.AddScoped<IPedidoService, PedidoService>();

var app = builder.Build();

// ── Base de datos: migraciones (o creación directa si aún no se generaron) + seeder ──
await InicializarBaseDeDatosAsync(app);

// Errores no controlados: respuesta JSON uniforme sin exponer detalles internos.
app.UseExceptionHandler(manejador => manejador.Run(async contexto =>
{
    var registro = contexto.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("Errores");
    var excepcion = contexto.Features.Get<Microsoft.AspNetCore.Diagnostics.IExceptionHandlerFeature>()?.Error;
    registro.LogError(excepcion, "Error no controlado en {Ruta}", contexto.Request.Path);
    contexto.Response.StatusCode = StatusCodes.Status500InternalServerError;
    contexto.Response.ContentType = "application/json";
    await contexto.Response.WriteAsJsonAsync(new { error = "Ocurrió un error interno. Inténtalo de nuevo." });
}));

app.UseCors("Frontend");

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}
else
{
    // En desarrollo se trabaja por http://localhost:5024; redirigir a HTTPS rompería el fetch del frontend.
    app.UseHttpsRedirection();
}

app.MapGet("/", () => "API de GINNA'S PIZZA funcionando.");

app.MapAuth();
app.MapClientes();
app.MapProductos();
app.MapProductAvailability();
app.MapPromociones();
app.MapPedidos();
app.MapInventario();
app.MapProveedores();
app.MapUsuarios();
app.MapReportes();

app.Run();

static async Task InicializarBaseDeDatosAsync(WebApplication app)
{
    var registro = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Inicio");
    const int intentos = 10;
    for (var intento = 1; ; intento++)
    {
        try
        {
            using var alcance = app.Services.CreateScope();
            var db = alcance.ServiceProvider.GetRequiredService<AppDbContext>();
            if (db.Database.GetMigrations().Any())
            {
                await db.Database.MigrateAsync();
            }
            else
            {
                registro.LogWarning("No hay migraciones en el proyecto; se crea el esquema con EnsureCreated. " +
                                    "Genera la migración con: dotnet ef migrations add Inicial");
                await db.Database.EnsureCreatedAsync();
            }
            await DatabaseSeeder.SembrarAsync(db, registro);
            return;
        }
        catch (Exception ex) when (intento < intentos && ex is Npgsql.NpgsqlException or System.Net.Sockets.SocketException or TimeoutException)
        {
            registro.LogWarning("PostgreSQL aún no responde (intento {Intento}/{Total}). Reintentando en 3 s...", intento, intentos);
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
    }
}
