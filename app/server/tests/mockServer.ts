// mockServer.ts
// Minimal Express server to test routes with mock data

import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import bodyParser from 'body-parser';
// import { fileURLToPath } from 'url';

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

const MOCK_DATA_ROOT = path.resolve('tests/mocks');
process.env.DATA_ROOT = MOCK_DATA_ROOT;

// Import the routes (assuming they use express.Router)
import { registerAllRoutes } from '../routes';


const app = express();
registerAllRoutes(app);
app.use(bodyParser.json());

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
  console.log(`Using mock data root: ${MOCK_DATA_ROOT}`);
});

export default app;
