const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 6789;
const GRAFANA_URL = 'http://localhost:3001';

// Get ingress path from environment variable (set by Home Assistant)
const INGRESS_PATH = process.env.INGRESS_PATH || '';
const BASE_PATH = INGRESS_PATH || '';

console.log(`Ingress path: ${INGRESS_PATH}`);
console.log(`Base path: ${BASE_PATH}`);

// Set EJS as template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Trust proxy headers (important for Home Assistant ingress)
app.set('trust proxy', true);

// Middleware to extract ingress path from headers if not in URL
app.use((req, res, next) => {
  const ingressHeader = req.headers['x-ingress-path'];
  
  console.log(`Request: ${req.method} ${req.path}`);
  console.log(`Ingress header: ${ingressHeader}`);
  console.log(`Original URL: ${req.originalUrl}`);
  
  // If we have an ingress header, use it to determine the ingress path
  if (ingressHeader) {
    req.ingressPath = ingressHeader;
    req.basePath = ingressHeader;
    console.log(`Set ingress path from header: ${ingressHeader}`);
  } else if (req.path.includes('/hassio_ingress/')) {
    // Handle case where HA stripped /api but path still contains hassio_ingress
    const pathParts = req.path.split('/');
    const ingressIndex = pathParts.indexOf('hassio_ingress');
    if (ingressIndex >= 0 && pathParts[ingressIndex + 1]) {
      req.ingressPath = `/api/hassio_ingress/${pathParts[ingressIndex + 1]}`;
      req.basePath = req.ingressPath;
      console.log(`Reconstructed ingress path: ${req.ingressPath}`);
    }
  } else {
    req.ingressPath = INGRESS_PATH;
    req.basePath = BASE_PATH;
  }
  
  next();
});

// Serve static files with proper base path handling
app.use('/static', express.static(path.join(__dirname, 'public')));
if (BASE_PATH) {
  app.use(`${BASE_PATH}/static`, express.static(path.join(__dirname, 'public')));
}

// Handle static files through ingress route
app.get('/api/hassio_ingress/:token/static/*', (req, res, next) => {
  const staticPath = req.params[0];
  const filePath = path.join(__dirname, 'public', staticPath);
  console.log(`Serving static file: ${staticPath} from ${filePath}`);
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Static file error:', err);
      res.status(404).send('File not found');
    }
  });
});

// Health check endpoint (should work from any path)
app.get('*/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    basePath: req.basePath || BASE_PATH,
    ingressPath: req.ingressPath || INGRESS_PATH,
    originalUrl: req.originalUrl,
    path: req.path
  });
});

// Favicon handler to prevent 404s
app.get('/favicon.ico', (req, res) => {
  res.status(204).send(); // No content
});

// Grafana proxy middleware with ingress support
const grafanaProxy = createProxyMiddleware({
  target: GRAFANA_URL,
  changeOrigin: true,
  ws: true, // Enable WebSocket proxying
  pathRewrite: (path, req) => {
    // Log the original path for debugging
    console.log(`Original proxy path: ${path}`);
    
    let newPath = path;
    const ingressPath = req.ingressPath || req.basePath || BASE_PATH;
    
    // Handle Home Assistant ingress path stripping
    // Requests may come in as /hassio_ingress/TOKEN/... instead of /api/hassio_ingress/TOKEN/...
    
    // Remove ingress path variations
    if (ingressPath && path.startsWith(ingressPath)) {
      newPath = path.substring(ingressPath.length);
      console.log(`After ingress removal (full): ${newPath}`);
    } else if (path.includes('/hassio_ingress/')) {
      // Handle stripped /api case
      const hassioIndex = path.indexOf('/hassio_ingress/');
      if (hassioIndex >= 0) {
        const afterHassio = path.substring(hassioIndex);
        const pathParts = afterHassio.split('/');
        if (pathParts.length >= 3) {
          // Skip /hassio_ingress/TOKEN/ part
          newPath = '/' + pathParts.slice(3).join('/');
          console.log(`After hassio_ingress removal: ${newPath}`);
        }
      }
    }
    
    // Remove /grafana prefix if present
    if (newPath.startsWith('/grafana')) {
      newPath = newPath.substring('/grafana'.length);
      console.log(`After /grafana removal: ${newPath}`);
    }
    
    // Ensure we have a leading slash
    if (!newPath.startsWith('/')) {
      newPath = '/' + newPath;
    }
    
    // Handle root grafana requests
    if (newPath === '/' || newPath === '') {
      newPath = '/';
    }
    
    console.log(`Final proxy path: ${path} -> ${newPath} (ingress: ${ingressPath})`);
    return newPath;
  },
  onProxyReq: (proxyReq, req, res) => {
    // Add headers for iframe embedding
    proxyReq.setHeader('X-Frame-Options', 'ALLOWALL');
    console.log(`Proxying to Grafana: ${req.method} ${proxyReq.path}`);
  },
  onProxyRes: (proxyRes, req, res) => {
    // Remove X-Frame-Options to allow iframe embedding
    delete proxyRes.headers['x-frame-options'];
    // Add CORS headers
    proxyRes.headers['Access-Control-Allow-Origin'] = '*';
    proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    
    console.log(`Grafana response: ${proxyRes.statusCode} for ${req.url}`);
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    console.error('Request URL:', req.url);
    console.error('Request path:', req.path);
    res.status(500).send('Proxy error occurred');
  }
});

// Apply proxy middleware to grafana routes
app.use('/grafana', grafanaProxy);
if (BASE_PATH) {
  app.use(`${BASE_PATH}/grafana`, grafanaProxy);
}

// Handle Grafana requests through ingress - these come without the full ingress path
app.use('/api/hassio_ingress/:token/grafana', (req, res, next) => {
  console.log(`Ingress Grafana request: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

// Handle Home Assistant stripped ingress paths (without /api prefix)
app.use('/hassio_ingress/:token/grafana', (req, res, next) => {
  console.log(`Stripped ingress Grafana request: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

// IMPORTANT: Handle specific Grafana routes ONLY, not all /api routes
// This prevents conflicts with our own API endpoints

// Handle direct Grafana dashboard requests
app.use('/d/*', grafanaProxy);
app.use('/public/*', grafanaProxy);
app.use('/plugins/*', grafanaProxy);

// Handle only Grafana-specific API routes, not all /api routes
app.use('/api/dashboards/*', grafanaProxy);
app.use('/api/datasources/*', grafanaProxy);
app.use('/api/health', grafanaProxy);
app.use('/api/org', grafanaProxy);
app.use('/api/user', grafanaProxy);
app.use('/api/users/*', grafanaProxy);
app.use('/api/search', grafanaProxy);
app.use('/api/annotations/*', grafanaProxy);
app.use('/api/frontend/*', grafanaProxy);
app.use('/api/live/*', grafanaProxy);

// Handle stripped ingress direct Grafana paths
app.use('/hassio_ingress/:token/d/*', (req, res, next) => {
  console.log(`Handling stripped Grafana dashboard route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

// Handle Grafana API routes through stripped ingress (be more specific)
app.use('/hassio_ingress/:token/api/dashboards/*', (req, res, next) => {
  console.log(`Handling stripped Grafana API route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

app.use('/hassio_ingress/:token/api/health', (req, res, next) => {
  console.log(`Handling stripped Grafana health route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

app.use('/hassio_ingress/:token/public/*', (req, res, next) => {
  console.log(`Handling stripped Grafana public route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

// Handle any other Grafana asset requests
app.use('/hassio_ingress/:token/plugins/*', (req, res, next) => {
  console.log(`Handling stripped Grafana plugins route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

app.use('/hassio_ingress/:token/avatar/*', (req, res, next) => {
  console.log(`Handling stripped Grafana avatar route: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  grafanaProxy(req, res, next);
});

// API endpoint to check Grafana status
const statusHandler = async (req, res) => {
  try {
    const response = await fetch(`${GRAFANA_URL}/api/health`);
    const status = response.ok ? 'healthy' : 'unhealthy';
    res.json({
      grafana: status,
      server: 'running',
      timestamp: new Date().toISOString(),
      basePath: req.basePath || BASE_PATH,
      ingressPath: req.ingressPath || INGRESS_PATH
    });
  } catch (error) {
    res.json({
      grafana: 'unreachable',
      server: 'running',
      error: error.message,
      timestamp: new Date().toISOString(),
      basePath: req.basePath || BASE_PATH
    });
  }
};

// IMPORTANT: Define our API routes BEFORE Grafana proxy routes
app.get('/api/status', statusHandler);
if (BASE_PATH) {
  app.get(`${BASE_PATH}/api/status`, statusHandler);
}

// Handle ingress API status routes specifically
app.get('/api/hassio_ingress/:token/api/status', (req, res) => {
  console.log(`Ingress API status request: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  statusHandler(req, res);
});

app.get('/hassio_ingress/:token/api/status', (req, res) => {
  console.log(`Stripped ingress API status request: ${req.url}`);
  req.ingressPath = `/api/hassio_ingress/${req.params.token}`;
  req.basePath = req.ingressPath;
  statusHandler(req, res);
});

// Debug route to test Grafana connectivity
app.get('/debug/grafana', async (req, res) => {
  try {
    const healthResponse = await fetch(`${GRAFANA_URL}/api/health`);
    const healthData = await healthResponse.text();
    
    const dbResponse = await fetch(`${GRAFANA_URL}/api/datasources`);
    const dbData = await dbResponse.text();
    
    res.json({
      grafanaHealth: {
        status: healthResponse.status,
        data: healthData
      },
      datasources: {
        status: dbResponse.status,
        data: dbData
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Simple test endpoint to verify Node.js app is working
app.get('/test', (req, res) => {
  res.json({
    message: 'Node.js app is working!',
    timestamp: new Date().toISOString(),
    path: req.path,
    url: req.url
  });
});

// Test endpoints for ingress paths
app.get('/api/hassio_ingress/:token/test', (req, res) => {
  res.json({
    message: 'Ingress Node.js app is working!',
    timestamp: new Date().toISOString(),
    token: req.params.token,
    path: req.path,
    url: req.url
  });
});

app.get('/hassio_ingress/:token/test', (req, res) => {
  res.json({
    message: 'Stripped ingress Node.js app is working!',
    timestamp: new Date().toISOString(),
    token: req.params.token,
    path: req.path,
    url: req.url
  });
});

// Simple test page for iframe testing
app.get('/test-iframe', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Test Page</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f0f0f0; }
        .success { color: green; font-size: 18px; }
      </style>
    </head>
    <body>
      <h1>✅ Test Page Loaded Successfully</h1>
      <p class="success">This page loaded correctly in the iframe!</p>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>URL:</strong> ${req.url}</p>
      <p><strong>Path:</strong> ${req.path}</p>
      <script>
        console.log('Test iframe page loaded successfully');
        // Try to communicate with parent if in iframe
        if (window.parent !== window) {
          try {
            window.parent.postMessage({type: 'test_success', timestamp: new Date().toISOString()}, '*');
          } catch(e) {
            console.log('Could not communicate with parent (normal for cross-origin)');
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Test iframe for ingress paths
app.get('/api/hassio_ingress/:token/test-iframe', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Ingress Test Page</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #e8f5e8; }
        .success { color: green; font-size: 18px; }
      </style>
    </head>
    <body>
      <h1>✅ Ingress Test Page Loaded Successfully</h1>
      <p class="success">This ingress page loaded correctly in the iframe!</p>
      <p><strong>Token:</strong> ${req.params.token}</p>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>URL:</strong> ${req.url}</p>
      <p><strong>Path:</strong> ${req.path}</p>
    </body>
    </html>
  `);
});

app.get('/hassio_ingress/:token/test-iframe', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Stripped Ingress Test Page</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; background: #f0e8f5; }
        .success { color: green; font-size: 18px; }
      </style>
    </head>
    <body>
      <h1>✅ Stripped Ingress Test Page Loaded Successfully</h1>
      <p class="success">This stripped ingress page loaded correctly in the iframe!</p>
      <p><strong>Token:</strong> ${req.params.token}</p>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>URL:</strong> ${req.url}</p>
      <p><strong>Path:</strong> ${req.path}</p>
    </body>
    </html>
  `);
});

// Test route to help with debugging path issues
app.get('/debug/paths', (req, res) => {
  res.json({
    originalUrl: req.originalUrl,
    path: req.path,
    url: req.url,
    baseUrl: req.baseUrl,
    headers: req.headers,
    ingressPath: req.ingressPath,
    basePath: req.basePath,
    configuredIngressPath: INGRESS_PATH,
    configuredBasePath: BASE_PATH,
    timestamp: new Date().toISOString()
  });
});

// Main dashboard route with ingress support
const dashboardHandler = (req, res) => {
  const currentBasePath = req.basePath || req.ingressPath || BASE_PATH;
  
  // Determine the correct Grafana URL based on the request host
  const host = req.get('host') || 'localhost:6789';
  const hostWithoutPort = host.split(':')[0];
  const grafanaBaseUrl = `http://${hostWithoutPort}:3001`;
  
  console.log(`Dashboard request - basePath: ${currentBasePath}, grafanaUrl: ${grafanaBaseUrl}`);
  console.log(`Request host: ${host}, Grafana host: ${hostWithoutPort}:3001`);
  
  const dashboardConfig = {
    title: 'SolarAutopilot Dashboard',
    grafanaUrl: grafanaBaseUrl,
    basePath: currentBasePath,
    dashboards: [
      {
        name: 'Home',
        url: `${grafanaBaseUrl}/d-solo/solar_dashboard?orgId=1&refresh=1m&panelId=2&theme=light`
      },
      {
        name: 'Dashboards',
        url: `${grafanaBaseUrl}/d-solo/solar_dashboard??orgId=1&refresh=1m&panelId=116&theme=light`
      },
      {
        name: 'Explore',
        url: `${grafanaBaseUrl}/d-solo/solar_dashboard??orgId=1&refresh=1m&panelId=139&theme=light`
      }
    ]
  };

  res.render('dashboard', dashboardConfig);
};

// Register dashboard routes - ROOT ROUTE FIRST
app.get('/', dashboardHandler);

// Then specific base path routes
if (BASE_PATH) {
  app.get(BASE_PATH, dashboardHandler);
  app.get(`${BASE_PATH}/`, dashboardHandler);
}

// Catch-all route for Home Assistant ingress paths (with /api prefix)
app.get('/api/hassio_ingress/:token', (req, res) => {
  const ingressToken = req.params.token;
  console.log(`Ingress access attempt with token: ${ingressToken}`);
  
  // Set the ingress path for this request
  req.ingressPath = `/api/hassio_ingress/${ingressToken}`;
  req.basePath = req.ingressPath;
  
  dashboardHandler(req, res);
});

app.get('/api/hassio_ingress/:token/*', (req, res) => {
  const ingressToken = req.params.token;
  const subPath = req.params[0];
  console.log(`Ingress sub-path access: ${subPath} with token: ${ingressToken}`);
  
  // Set the ingress path for this request
  req.ingressPath = `/api/hassio_ingress/${ingressToken}`;
  req.basePath = req.ingressPath;
  
  // Handle static files
  if (subPath && subPath.startsWith('static/')) {
    const staticPath = subPath.substring('static/'.length);
    const filePath = path.join(__dirname, 'public', staticPath);
    console.log(`Serving static file: ${staticPath} from ${filePath}`);
    
    return res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Static file error:', err);
        res.status(404).json({ error: 'File not found', path: staticPath });
      }
    });
  }
  
  // Handle API endpoints
  if (subPath && subPath.startsWith('api/')) {
    if (subPath === 'api/status') {
      return statusHandler(req, res);
    }
  }
  
  // Handle Grafana routes (already handled by proxy middleware above)
  if (subPath && subPath.startsWith('grafana/')) {
    // This should be handled by the proxy middleware
    console.log(`Grafana request should be handled by proxy: ${subPath}`);
    return res.status(500).json({ error: 'Grafana proxy routing issue', path: subPath });
  }
  
  // If it's the root or dashboard path, serve the dashboard
  if (!subPath || subPath === '' || subPath === '/') {
    return dashboardHandler(req, res);
  } else {
    // Handle other sub-paths as needed
    console.log(`Unhandled ingress sub-path: ${subPath}`);
    res.status(404).render('error', {
      error: '404 - Page Not Found',
      message: `The requested URL ${req.url} was not found on this server.`,
      basePath: req.basePath
    });
  }
});

// Handle Home Assistant stripped ingress paths (without /api prefix)
app.get('/hassio_ingress/:token', (req, res) => {
  const ingressToken = req.params.token;
  console.log(`Stripped ingress access attempt with token: ${ingressToken}`);
  
  // Set the ingress path for this request
  req.ingressPath = `/api/hassio_ingress/${ingressToken}`;
  req.basePath = req.ingressPath;
  
  dashboardHandler(req, res);
});

app.get('/hassio_ingress/:token/*', (req, res) => {
  const ingressToken = req.params.token;
  const subPath = req.params[0];
  console.log(`Stripped ingress sub-path access: ${subPath} with token: ${ingressToken}`);
  
  // Set the ingress path for this request
  req.ingressPath = `/api/hassio_ingress/${ingressToken}`;
  req.basePath = req.ingressPath;
  
  // Handle static files
  if (subPath && subPath.startsWith('static/')) {
    const staticPath = subPath.substring('static/'.length);
    const filePath = path.join(__dirname, 'public', staticPath);
    console.log(`Serving static file: ${staticPath} from ${filePath}`);
    
    return res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Static file error:', err);
        res.status(404).json({ error: 'File not found', path: staticPath });
      }
    });
  }
  
  // Handle API endpoints
  if (subPath && subPath.startsWith('api/')) {
    if (subPath === 'api/status') {
      return statusHandler(req, res);
    }
  }
  
  // If it's the root or dashboard path, serve the dashboard
  if (!subPath || subPath === '' || subPath === '/') {
    return dashboardHandler(req, res);
  } else {
    // Handle other sub-paths as needed
    console.log(`Unhandled stripped ingress sub-path: ${subPath}`);
    res.status(404).render('error', {
      error: '404 - Page Not Found',
      message: `The requested URL ${req.url} was not found on this server.`,
      basePath: req.basePath
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).render('error', {
    error: 'Internal Server Error',
    message: err.message,
    basePath: req.basePath || BASE_PATH
  });
});

// 404 handler with ingress support
app.use((req, res) => {
  console.log(`404 for path: ${req.path}`);
  console.log(`Original URL: ${req.originalUrl}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  
  res.status(404).render('error', {
    error: '404 - Page Not Found',
    message: `The requested URL ${req.url} was not found on this server.`,
    basePath: req.basePath || BASE_PATH
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Solar Server running on port ${PORT}`);
  console.log(`📊 Dashboard available at: http://localhost:${PORT}${BASE_PATH}`);
  console.log(`🔗 Grafana proxy available at: http://localhost:${PORT}${BASE_PATH}/grafana`);
  console.log(`🏠 Ingress path: ${INGRESS_PATH}`);
});
