// Root entrypoint for dev server and cloud deployment
const { app } = require('./src/planner/server.js');

const PORT = Number(process.env.PORT || process.env.PLANNER_PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Materials purchase planner running on http://${HOST}:${PORT}`);
});
