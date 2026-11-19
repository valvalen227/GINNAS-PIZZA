# 🍕 Ginna's Pizza

Sistema web para una pizzería con dos partes:

- **Tienda pública:** los clientes ven el menú y las promociones, arman su pedido y pueden registrarse para acceder a ofertas exclusivas.
- **Panel administrativo:** el personal gestiona pedidos, ventas, inventario, productos, combos, clientes, proveedores, usuarios y reportes, según su rol.

## Tecnologías

| Capa | Tecnología |
|---|---|
| Frontend | HTML, CSS y JavaScript puro (sin frameworks), Chart.js para las gráficas |
| Backend | ASP.NET Core Minimal API (.NET 10), Entity Framework Core |
| Base de datos | PostgreSQL 16 (con Docker) |
| Autenticación | Token firmado (HMAC), contraseñas con PBKDF2-SHA256 |

## Estructura del proyecto

```
Proyecto Analisis/
├── index.html              # Tienda pública + panel administrativo
├── styles.css              # Estilos
├── script.js               # Lógica del frontend y consumo de la API
├── paginacion.js           # Paginador reutilizable para las tablas
├── assets/img/             # Logo
└── backend/GinnasPizza.Api/
    ├── Program.cs          # Configuración, CORS, migraciones y rutas
    ├── Endpoints/          # Rutas de la API (una por módulo)
    ├── Models/             # Entidades de la base de datos
    ├── Contracts/          # DTOs de entrada y salida
    ├── Services/           # Pedidos, disponibilidad, promociones, tokens
    ├── Data/               # AppDbContext y seeder de datos iniciales
    ├── Migrations/         # Migraciones de EF Core
    └── appsettings.example.json
```

## Módulos y roles

| Módulo | Administrador | Cajero | Mesera |
|---|:-:|:-:|:-:|
| Dashboard, Reportes, Usuarios, Proveedores | ✅ | | |
| Pedidos (crear, consultar, cambiar estado) | ✅ | ✅ | ✅ |
| Ventas y cobros | ✅ | ✅ | |
| Inventario y Clientes (consulta) | ✅ | ✅ | ✅ |
| Inventario y Clientes (crear, editar, eliminar) | ✅ | | |
| Productos y Combos (crear, editar, eliminar) | ✅ | | |

Los permisos se validan en el backend con `RequireRoles` en cada ruta (ver `Endpoints/`).

Funciones destacadas del panel:
- Tablas con **paginación** (5, 10, 20 o 50 registros por página).
- Pedidos con estados (Pendiente, Confirmado, En preparación, Listo, Entregado, Cancelado) y cobro por separado.
- Al cancelar un pedido, los ingredientes vuelven al inventario.
- Promociones y combos con foto, vigencia y precio especial.

## Requisitos

- [.NET SDK 10](https://dotnet.microsoft.com/download)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (para PostgreSQL)
- Un navegador moderno
- Git

## Instalación y ejecución

### 1. Clonar el repositorio

```bash
git clone https://github.com/valvalen227/GINNAS-PIZZA.git
cd GINNAS-PIZZA
```

### 2. Levantar PostgreSQL

```bash
docker run -d --name ginnas-db -p 5433:5432 \
  -e POSTGRES_PASSWORD=TU_PASSWORD_DE_POSTGRES \
  -e POSTGRES_DB=ginnas_pizza_db \
  postgres:16
```

### 3. Configurar el backend

El archivo `appsettings.json` **no se sube al repositorio** porque contiene credenciales. Créalo a partir del ejemplo:

```bash
cd backend/GinnasPizza.Api
cp appsettings.example.json appsettings.json
```

Edita `appsettings.json` y cambia:
- `ConnectionStrings:DefaultConnection`: la contraseña debe ser la misma del paso 2.
- `Auth:SigningKey`: una clave larga y aleatoria.

### 4. Iniciar la API

```bash
dotnet run
```

La API queda en **http://localhost:5024**. Al arrancar aplica las migraciones y crea los datos iniciales (usuarios, productos, ingredientes, combos). Documentación OpenAPI en desarrollo: `http://localhost:5024/openapi/v1.json`.

> Si cambias código del backend, reinicia la API (`Ctrl + C` y `dotnet run`); si no, seguirá corriendo la versión anterior.

### 5. Abrir el frontend

Abre `index.html` en el navegador (o con la extensión Live Server de VS Code). El frontend se conecta a `http://localhost:5024`; ese valor está en la constante `API_BASE` al inicio de `script.js`.

## Cuentas de prueba (personal)

| Rol | Usuario | Contraseña |
|---|---|---|
| Administrador | `admin` o `admin@ginnaspizza.com` | `Admin123*` |
| Cajero | `cajero` o `cajero@ginnaspizza.com` | `Cajero123*` |
| Mesera | `mesera` o `mesera@ginnaspizza.com` | `Mesera123*` |

Son solo para desarrollo: cámbialas antes de publicar el sistema. Los clientes de la tienda se registran desde la página pública (contraseña de mínimo 8 caracteres).

## API (resumen)

Todas las rutas empiezan por `/api`. Las protegidas requieren `Authorization: Bearer <token>`.

| Recurso | Rutas |
|---|---|
| Autenticación | `POST /auth/login`, `GET /auth/me` |
| Clientes (tienda) | `POST /clientes/registro`, `POST /clientes/login`, `GET /clientes/me` |
| Clientes (panel) | `GET/POST /clientes`, `PUT/DELETE /clientes/{id}` |
| Productos | `GET/POST /productos`, `PUT/DELETE /productos/{id}`, `PUT /productos/{id}/recetas`, `GET /productos/disponibilidad` |
| Promociones | `GET /promociones`, `GET /promociones/vigentes`, `POST /promociones`, `PUT/DELETE /promociones/{id}`, `PATCH /promociones/{id}/estado` |
| Pedidos | `POST /pedidos/web`, `GET/POST /pedidos`, `GET /pedidos/{id}`, `PATCH /pedidos/{id}/estado`, `POST /pedidos/{id}/pago` |
| Ventas | `GET /ventas` |
| Inventario | `/ingredientes` (CRUD y estado), `GET/POST /inventario/movimientos` |
| Proveedores | `/proveedores` (CRUD y estado) |
| Usuarios | `GET/POST /usuarios`, `PUT/DELETE /usuarios/{id}`, `POST /usuarios/{id}/password` |
| Reportes | `GET /reportes` |

## Seguridad

- Contraseñas almacenadas con PBKDF2-SHA256 (210.000 iteraciones) y sal aleatoria.
- Bloqueo temporal tras varios intentos fallidos de inicio de sesión.
- CORS abierto solo en desarrollo; en producción se limita a los orígenes de `Cors:Origins`.
- `appsettings.json` y las cuentas de prueba son solo para desarrollo.

## Solución de problemas

| Problema | Causa probable |
|---|---|
| "No se pudo conectar con el servidor" | La API no está corriendo en el puerto 5024 |
| La API no arranca con "address already in use" | Ya hay otra instancia corriendo; ciérrala primero |
| Errores de conexión a la base de datos | El contenedor `ginnas-db` está detenido o la contraseña de `appsettings.json` no coincide |
| Cambios del backend que no se ven | Falta reiniciar la API |
