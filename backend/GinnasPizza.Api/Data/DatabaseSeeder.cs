using GinnasPizza.Api.Models;
using GinnasPizza.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace GinnasPizza.Api.Data;

/// <summary>
/// Datos iniciales. Solo se ejecuta cuando la base de datos está vacía (sin usuarios, productos ni ingredientes),
/// por lo que reiniciar la API nunca vuelve a crear registros que alguien haya eliminado a propósito.
/// </summary>
public static class DatabaseSeeder
{
    /// <summary>Dominio del personal: el login acepta "admin" como atajo de admin@ginnaspizza.com.</summary>
    public const string DominioPersonal = "ginnaspizza.com";

    // ── Imágenes reales (Unsplash, formato optimizado) ──
    private const string Calidad = "?w=800&q=80";
    private static string Foto(string id) => $"https://images.unsplash.com/photo-{id}{Calidad}";

    private static readonly Dictionary<string, string> ImagenesProductos = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Pizza Napolitana"] = Foto("1574071318508-1cdbab80d002"),
        ["Pizza Pepperoni"] = Foto("1628840042765-356cda07504e"),
        ["Pizza Hawaiana"] = Foto("1594007654729-407eedc4be65"),
        ["Pizza Criolla"] = Foto("1593560708920-61dd98c46a4e"),
        ["Pizza Mexicana"] = Foto("1604382354936-07c5d9983bd3"),
        ["Coca-Cola 600ml"] = Foto("1622483767028-3f66f32aef97"),
        ["Agua natural 1L"] = Foto("1548839140-29a749e1cf4d"),
        ["Limonada natural"] = Foto("1621263764928-df1444c5e859"),
        ["Queso extra"] = Foto("1486297678162-eb2a19b0a32d"),
        ["Pepperoni extra"] = Foto("1534308983496-4fabb1a015ee"),
        ["Maíz tierno extra"] = Foto("1551754655-cd27e38d2076"),
    };

    private static readonly Dictionary<string, string> ImagenesPromociones = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Combo personal"] = Foto("1605478371310-a9f1e96b4ff4"),
        ["Combo familiar"] = Foto("1571407970349-bc81e7e96d47"),
        ["Combo para compartir"] = Foto("1590947132387-155cc02f3212"),
    };

    // ── Usuarios base: (nombre, correo, contraseña, rol, correo anterior) ──
    private static readonly (string Nombre, string Correo, string Password, string Rol, string CorreoAnterior)[] UsuariosBase =
    [
        ("Ginna Administradora", $"admin@{DominioPersonal}", "Admin123*", Roles.Administrador, "admin@ginnas.com"),
        ("Laura Cajero", $"cajero@{DominioPersonal}", "Cajero123*", Roles.Cajero, "cajera@ginnas.com"),
        ("Marta Mesera", $"mesera@{DominioPersonal}", "Mesera123*", Roles.Mesera, "mesera@ginnas.com"),
    ];

    /// <summary>
    /// Garantiza las tres cuentas de prueba. Si no existen se crean; si existe la cuenta de una versión anterior
    /// (otro correo) se migra al nuevo correo, rol y contraseña. Una cuenta que ya tiene el correo nuevo no se toca.
    /// </summary>
    private static async Task AsegurarUsuariosBaseAsync(AppDbContext db, ILogger logger, CancellationToken ct)
    {
        // Normaliza el rol antiguo "Cajera" → "Cajero".
        foreach (var u in await db.Usuarios.Where(u => u.Rol == "Cajera").ToListAsync(ct)) u.Rol = Roles.Cajero;

        foreach (var (nombre, correo, password, rol, anterior) in UsuariosBase)
        {
            if (await db.Usuarios.AnyAsync(u => u.Correo == correo, ct)) continue;
            var existente = await db.Usuarios.FirstOrDefaultAsync(u => u.Correo == anterior, ct);
            if (existente is not null)
            {
                existente.Correo = correo;
                existente.Rol = rol;
                existente.Activo = true;
                existente.PasswordHash = PasswordHasher.Hash(password);
                logger.LogInformation("Cuenta {Anterior} migrada a {Correo}.", anterior, correo);
            }
            else
            {
                db.Usuarios.Add(new Usuario { Nombre = nombre, Correo = correo, PasswordHash = PasswordHasher.Hash(password), Rol = rol });
            }
        }
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Rellena las imágenes vacías de productos y promociones conocidos (nunca pisa una imagen ya cargada).</summary>
    private static async Task CompletarImagenesAsync(AppDbContext db, CancellationToken ct)
    {
        foreach (var p in await db.Productos.Where(p => p.Imagen == "").ToListAsync(ct))
            if (ImagenesProductos.TryGetValue(p.Nombre, out var url)) p.Imagen = url;
        foreach (var p in await db.Promociones.Where(p => p.Imagen == "").ToListAsync(ct))
            if (ImagenesPromociones.TryGetValue(p.Nombre, out var url)) p.Imagen = url;
        await db.SaveChangesAsync(ct);
    }

    public static async Task SembrarAsync(AppDbContext db, ILogger logger, CancellationToken ct = default)
    {
        if (await db.Usuarios.AnyAsync(ct) || await db.Productos.AnyAsync(ct) || await db.Ingredientes.AnyAsync(ct))
        {
            logger.LogInformation("La base de datos ya contiene datos; se omite el seeder (solo se verifican cuentas base e imágenes).");
            await AsegurarUsuariosBaseAsync(db, logger, ct);
            await CompletarImagenesAsync(db, ct);
            return;
        }

        logger.LogInformation("Base de datos vacía: sembrando datos iniciales...");
        var ahora = DateTime.UtcNow;

        // ── Usuarios internos (contraseñas hasheadas con PBKDF2 en el backend) ──
        db.Usuarios.AddRange(UsuariosBase.Select(u => new Usuario
        {
            Nombre = u.Nombre, Correo = u.Correo, PasswordHash = PasswordHasher.Hash(u.Password), Rol = u.Rol, FechaCreacion = ahora
        }));

        // ── Cliente de prueba con cuenta web (para probar promociones exclusivas) ──
        db.Clientes.Add(new Cliente
        {
            Nombre = "Cliente Demo", Correo = "cliente@ginnas.com", Telefono = "3001234567", Direccion = "Calle 10 # 5-20, El Jardín",
            PasswordHash = PasswordHasher.Hash("Cliente2026*"), FechaRegistro = ahora
        });

        // ── Proveedores ──
        var lacteos = new Proveedor { Nombre = "Lácteos del Valle", Telefono = "3104445555", Correo = "ventas@lacteos.com", Productos = "Quesos, mozzarella" };
        var tomate = new Proveedor { Nombre = "Distribuidora Tomate SA", Telefono = "3106667777", Correo = "contacto@tomate.com", Productos = "Salsas, tomate, verduras" };
        var carnicos = new Proveedor { Nombre = "Cárnicos Premium", Telefono = "3108889999", Correo = "pedidos@carnicos.com", Productos = "Pepperoni, jamón, pollo, carne" };
        var bebidas = new Proveedor { Nombre = "Bebidas Express", Telefono = "3101112222", Correo = "ventas@bebidas.com", Productos = "Refrescos, aguas" };
        db.Proveedores.AddRange(lacteos, tomate, carnicos, bebidas);

        // ── Ingredientes con stock actual y mínimo ──
        Ingrediente Ing(string nombre, string categoria, string unidad, decimal stock, decimal minimo, decimal costo, Proveedor? proveedor) => new()
        {
            Nombre = nombre, Categoria = categoria, UnidadMedida = unidad, StockActual = stock, StockMinimo = minimo,
            CostoUnitario = costo, Proveedor = proveedor, FechaActualizacion = ahora
        };

        var harina = Ing("Harina de trigo", "Harinas", "kg", 60, 20, 3200, null);
        var salsa = Ing("Salsa de tomate", "Salsas", "L", 25, 8, 9500, tomate);
        var queso = Ing("Queso mozzarella", "Quesos", "kg", 30, 10, 26000, lacteos);
        var pepperoni = Ing("Pepperoni", "Carnes", "kg", 10, 3, 42000, carnicos);
        var aceitunas = Ing("Aceitunas", "Verduras", "kg", 1.5m, 2, 18000, tomate); // bajo el mínimo a propósito: genera alerta
        var jamon = Ing("Jamón", "Carnes", "kg", 12, 4, 24000, carnicos);
        var pina = Ing("Piña", "Verduras", "kg", 8, 3, 6000, tomate);
        var carne = Ing("Carne molida", "Carnes", "kg", 8, 3, 28000, carnicos);
        var pollo = Ing("Pollo", "Carnes", "kg", 8, 3, 16000, carnicos);
        var maiz = Ing("Maíz tierno", "Verduras", "kg", 6, 2, 9000, tomate);
        var cebolla = Ing("Cebolla", "Verduras", "kg", 6, 2, 3500, tomate);
        var tomateFresco = Ing("Tomate", "Verduras", "kg", 7, 2, 4000, tomate);
        var albahaca = Ing("Albahaca", "Verduras", "kg", 2, 0.5m, 22000, tomate);
        var parmesano = Ing("Queso parmesano", "Quesos", "kg", 5, 1, 48000, lacteos);
        var picante = Ing("Ají picante", "Verduras", "kg", 2, 0.5m, 12000, tomate);
        var cocaCola = Ing("Coca-Cola 600ml", "Bebidas", "botella", 48, 12, 2600, bebidas);
        var agua = Ing("Agua natural 1L", "Bebidas", "botella", 36, 10, 1800, bebidas);
        var limonada = Ing("Limonada natural", "Bebidas", "unidad", 30, 10, 1500, null);
        db.Ingredientes.AddRange(harina, salsa, queso, pepperoni, aceitunas, jamon, pina, carne, pollo, maiz, cebolla,
            tomateFresco, albahaca, parmesano, picante, cocaCola, agua, limonada);

        // ── Productos con precio por tamaño ──
        Producto Pizza(string nombre, string descripcion, decimal personal, decimal mediana, decimal familiar) => new()
        {
            Nombre = nombre, Descripcion = descripcion, Categoria = Categorias.Pizzas, Emoji = "🍕",
            Precio = personal, PrecioMediana = mediana, PrecioFamiliar = familiar, FechaCreacion = ahora
        };
        Producto Simple(string nombre, string descripcion, string categoria, string emoji, decimal precio, string presentacion) => new()
        {
            Nombre = nombre, Descripcion = descripcion, Categoria = categoria, Emoji = emoji, Precio = precio,
            Presentacion = presentacion, FechaCreacion = ahora
        };

        var napolitana = Pizza("Pizza Napolitana", "Tomate, mozzarella y albahaca fresca", 28000, 48000, 70000);
        var pepperoniPizza = Pizza("Pizza Pepperoni", "Clásica con pepperoni importado", 26000, 44000, 64000);
        var hawaiana = Pizza("Pizza Hawaiana", "Jamón y piña natural", 26000, 44000, 64000);
        var criolla = Pizza("Pizza Criolla", "Mozzarella, maíz tierno, parmesano, carne molida y pollo", 26000, 44000, 64000);
        var mexicana = Pizza("Pizza Mexicana", "Carne molida, pollo, cebolla, tomate y picante", 26000, 44000, 64000);
        var cocaProducto = Simple("Coca-Cola 600ml", "Refresco personal bien frío", Categorias.Bebidas, "🥤", 5000, "600 ml");
        var aguaProducto = Simple("Agua natural 1L", "Agua purificada", Categorias.Bebidas, "💧", 4500, "1 L");
        var limonadaProducto = Simple("Limonada natural", "Limón fresco de la casa", Categorias.Bebidas, "🍋", 5000, "unidad");
        var quesoExtra = Simple("Queso extra", "Porción adicional de mozzarella", Categorias.Adiciones, "🧀", 4000, "porción");
        var pepperoniExtra = Simple("Pepperoni extra", "Porción adicional de pepperoni", Categorias.Adiciones, "🍖", 5000, "porción");
        var maizExtra = Simple("Maíz tierno extra", "Porción adicional de maíz tierno", Categorias.Adiciones, "🌽", 3000, "porción");
        db.Productos.AddRange(napolitana, pepperoniPizza, hawaiana, criolla, mexicana, cocaProducto, aguaProducto,
            limonadaProducto, quesoExtra, pepperoniExtra, maizExtra);

        // ── Recetas ──
        // Base común por tamaño: [Personal, Mediana, Familiar]
        var baseCantidades = new (Ingrediente Ingrediente, decimal[] PorTamano)[]
        {
            (harina, [0.15m, 0.22m, 0.30m]),
            (salsa, [0.06m, 0.09m, 0.12m]),
            (queso, [0.12m, 0.18m, 0.24m]),
        };
        void RecetaPizza(Producto pizza, params (Ingrediente Ingrediente, decimal[] PorTamano)[] sabor)
        {
            for (var i = 0; i < Tamanos.Pizza.Length; i++)
            {
                foreach (var (ingrediente, cantidades) in baseCantidades.Concat(sabor))
                {
                    db.Recetas.Add(new Receta { Producto = pizza, Ingrediente = ingrediente, Tamano = Tamanos.Pizza[i], Cantidad = cantidades[i] });
                }
            }
        }
        RecetaPizza(napolitana, (albahaca, [0.01m, 0.015m, 0.02m]), (parmesano, [0.02m, 0.03m, 0.04m]));
        RecetaPizza(pepperoniPizza, (pepperoni, [0.08m, 0.12m, 0.16m]));
        RecetaPizza(hawaiana, (jamon, [0.07m, 0.10m, 0.14m]), (pina, [0.06m, 0.09m, 0.12m]));
        RecetaPizza(criolla, (maiz, [0.04m, 0.06m, 0.08m]), (parmesano, [0.02m, 0.03m, 0.04m]), (carne, [0.05m, 0.075m, 0.10m]), (pollo, [0.04m, 0.06m, 0.08m]));
        RecetaPizza(mexicana, (carne, [0.06m, 0.09m, 0.12m]), (pollo, [0.05m, 0.075m, 0.10m]), (cebolla, [0.02m, 0.03m, 0.04m]), (tomateFresco, [0.03m, 0.045m, 0.06m]), (picante, [0.01m, 0.015m, 0.02m]));

        // Productos sin tamaño: la receta consume 1 unidad del artículo (bebidas) o una porción (adiciones).
        db.Recetas.AddRange(
            new Receta { Producto = cocaProducto, Ingrediente = cocaCola, Tamano = "", Cantidad = 1 },
            new Receta { Producto = aguaProducto, Ingrediente = agua, Tamano = "", Cantidad = 1 },
            new Receta { Producto = limonadaProducto, Ingrediente = limonada, Tamano = "", Cantidad = 1 },
            new Receta { Producto = quesoExtra, Ingrediente = queso, Tamano = "", Cantidad = 0.06m },
            new Receta { Producto = pepperoniExtra, Ingrediente = pepperoni, Tamano = "", Cantidad = 0.05m },
            new Receta { Producto = maizExtra, Ingrediente = maiz, Tamano = "", Cantidad = 0.04m });

        // ── Promociones activas ──
        db.Promociones.AddRange(
            new Promocion
            {
                Nombre = "Combo personal", Descripcion = "Pizza Pepperoni personal + Coca-Cola 600 ml", Emoji = "🍕🥤",
                Publico = "clientes", TipoDescuento = "fijo", ValorDescuento = 5000, Activa = true,
                Componentes =
                [
                    new PromocionComponente { Producto = pepperoniPizza, Tamano = Tamanos.Personal, Cantidad = 1 },
                    new PromocionComponente { Producto = cocaProducto, Tamano = "", Cantidad = 1 }
                ]
            },
            new Promocion
            {
                Nombre = "Combo familiar", Descripcion = "Pizza Napolitana familiar + Coca-Cola 600 ml", Emoji = "🍕🥤",
                Publico = "clientes", TipoDescuento = "fijo", ValorDescuento = 5000, Activa = true,
                Componentes =
                [
                    new PromocionComponente { Producto = napolitana, Tamano = Tamanos.Familiar, Cantidad = 1 },
                    new PromocionComponente { Producto = cocaProducto, Tamano = "", Cantidad = 1 }
                ]
            },
            new Promocion
            {
                Nombre = "Combo para compartir", Descripcion = "Pizza Hawaiana familiar + dos Coca-Cola 600 ml", Emoji = "🍕🥤",
                Publico = "general", TipoDescuento = "porcentaje", ValorDescuento = 8, Activa = true,
                Componentes =
                [
                    new PromocionComponente { Producto = hawaiana, Tamano = Tamanos.Familiar, Cantidad = 1 },
                    new PromocionComponente { Producto = cocaProducto, Tamano = "", Cantidad = 2 }
                ]
            });

        // ── Kardex inicial: cada ingrediente arranca con una entrada de existencia inicial ──
        foreach (var ingrediente in new[] { harina, salsa, queso, pepperoni, aceitunas, jamon, pina, carne, pollo, maiz, cebolla,
                     tomateFresco, albahaca, parmesano, picante, cocaCola, agua, limonada })
        {
            db.MovimientosInventario.Add(new MovimientoInventario
            {
                Ingrediente = ingrediente, Tipo = "Entrada", Cantidad = ingrediente.StockActual,
                Motivo = "Existencia inicial", Fecha = ahora, Usuario = "Sistema"
            });
        }

        await db.SaveChangesAsync(ct);
        await CompletarImagenesAsync(db, ct);
        logger.LogInformation("Seeder completado: 3 usuarios, 1 cliente, 18 ingredientes, 11 productos, 3 promociones.");
    }
}
