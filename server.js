// Root entrypoint for dev server and cloud deployment
const { app } = require('./src/planner/server.js');

const PORT = Number(process.env.PORT || process.env.PLANNER_PORT) || 3000;
// Localhost by default — this tool has no auth layer (see CLAUDE.md). A hosted
// deploy that needs to accept outside connections must opt in explicitly with
// HOST=0.0.0.0; binding every interface silently is not the default.
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`Materials purchase planner running on http://${HOST}:${PORT}`);
});
