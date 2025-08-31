# tg-ws-relay

WebSocket to WebSocket relay for Telegram MTProto-over-WebSocket. Acts as a bridge between browser WebSocket clients and any upstream WebSocket endpoint.

## Features

- **Pure WebSocket relay** - No raw TCP, no MTProxy handshake
- **Flexible upstream URLs** - Client specifies the upstream WebSocket endpoint
- **Security features** - Origin allowlist, upstream host validation, optional token authentication
- **Production-ready** - Backpressure handling, health checks, graceful shutdown
- **Comprehensive logging** - Structured JSON logs with correlation IDs
- **Docker support** - Ready to deploy as a container

## Quick Start

### Development

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your settings
nano .env

# Run in development mode
npm run dev
```

### Production

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

### Docker

```bash
# Build image
docker build -t tg-ws-relay .

# Run container
docker run -p 8080:8080 --env-file .env tg-ws-relay

# Or use docker-compose
docker-compose up -d
```

## Configuration

All configuration is done via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `ALLOWED_ORIGINS` | *(empty)* | CSV list of allowed origins (empty = allow all) |
| `TOKEN` | *(empty)* | Optional shared token for authentication |
| `LOG_LEVEL` | `debug` | Log level: trace, debug, info, warn, error |
| `LOG_PRETTY` | `false` | Enable pretty logging for development |
| `CLIENT_IDLE_TIMEOUT_MS` | `120000` | Client idle timeout (ms) |
| `UPSTREAM_IDLE_TIMEOUT_MS` | `120000` | Upstream idle timeout (ms) |
| `PING_INTERVAL_MS` | `25000` | WebSocket ping interval (ms) |
| `MAX_BUFFERED_BYTES` | `5000000` | Backpressure threshold (bytes) |
| `ALLOWED_UPSTREAM_HOSTS` | *(required)* | CSV list of allowed upstream host patterns (supports wildcards) |

## WebSocket Connection

Connect to the relay with:
```
wss://your-domain.com/apiws?upstream=wss%3A%2F%2Fvenus.web.telegram.org%2Fapiws&token=your-token
```

Parameters:
- `upstream` - URL-encoded upstream WebSocket URL (required)
- `token` - Authentication token (if configured)

Required WebSocket subprotocol: `binary`

## Allowed Upstream Hosts

The `ALLOWED_UPSTREAM_HOSTS` environment variable is **required** and controls which upstream hosts can be connected to. It supports wildcard patterns for flexible matching:

### Pattern Examples:
- `*.telegram.org` - Allow any subdomain of telegram.org
- `*.web.telegram.org` - Allow any subdomain of web.telegram.org  
- `pluto.web.telegram.org` - Allow exact host only
- `*.telegram.org,*.example.com` - Multiple patterns (comma-separated)

### Common Telegram Endpoints:
- Planet names: `pluto`, `venus`, `aurora`, `vesta`, `flora`
- Zone names: `zws1` through `zws8`
- All under: `*.web.telegram.org`

**Note:** If no patterns are configured, all connections will be rejected.

## TLS/SSL Setup

The relay runs on HTTP/WS. Use a reverse proxy for HTTPS/WSS:

### Nginx
See `docs/nginx/tg-ws-relay.conf` for a complete example.

### Key configuration:
```nginx
location /apiws {
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_pass http://127.0.0.1:8080/apiws;
}
```

## Health Check

The relay exposes `/health` endpoint:
```bash
curl http://localhost:8080/health
# Returns: ok
```

## Security Considerations

1. **Always use TLS** - Deploy behind HTTPS/WSS reverse proxy
2. **Set allowed origins** - Restrict `ALLOWED_ORIGINS` in production
3. **Use authentication** - Configure `TOKEN` for access control
4. **Monitor logs** - Watch for unusual patterns or errors
5. **Rate limiting** - Implement at reverse proxy level

## Logging

The relay uses structured JSON logging with Pino. Each connection gets a unique `connId` for correlation.

Log levels:
- `trace` - Very detailed, includes all WebSocket events
- `debug` - Detailed operational info (default)
- `info` - Important events only
- `warn` - Warnings and potential issues
- `error` - Errors only

## Scripts

- `npm run dev` - Run with hot reload (development)
- `npm run build` - Build TypeScript
- `npm start` - Run production server
- `npm run typecheck` - Type check without building
- `npm run lint` - Run ESLint
- `npm run format` - Format with Prettier

## License

MIT