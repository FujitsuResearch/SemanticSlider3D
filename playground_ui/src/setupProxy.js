const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Trellis server routes (REST + Socket.IO)
  app.use('/trellis', createProxyMiddleware({
    target: 'http://localhost:5002',
    changeOrigin: true,
  }));
  app.use('/socket.io', createProxyMiddleware({
    target: 'http://localhost:5002',
    changeOrigin: true,
    ws: true,
  }));

  // All other API routes → existing sam3d server
  app.use(
    ['/upload', '/uploads', '/downloads', '/segment', '/finish_object', '/to_3d',
     '/combine_objects', '/uncombine_object', '/delete_object', '/reset',
     '/start_session', '/resume_session', '/get_user_sessions', '/log_behavior',
     '/resolve_variant', '/serve_variant', '/save_object_states'],
    createProxyMiddleware({
      target: 'http://localhost:5001',
      changeOrigin: true,
    })
  );
};
