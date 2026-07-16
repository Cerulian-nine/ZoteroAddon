import { SotaClient } from '@sota-io/sdk';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const apiKey = process.env.SOTA_API_KEY;
if (!apiKey) {
  console.error('SOTA_API_KEY is not set. Add it as a GitHub Actions secret.');
  process.exit(1);
}

const projectName = process.env.SOTA_PROJECT_NAME || 'citepocket';
const sota = new SotaClient({ apiKey });

const { projects } = await sota.listProjects({ limit: 100 });
console.log(`Projects visible to this API key (${projects.length}):`);
for (const p of projects) {
  console.log(`  - name=${JSON.stringify(p.name)} slug=${p.slug} id=${p.id}`);
}

let project = projects.find((p) => p.slug === projectName || p.name === projectName);
if (!project && process.env.SOTA_PROJECT_ID) {
  project = projects.find((p) => p.id === process.env.SOTA_PROJECT_ID);
}
if (!project) {
  try {
    project = await sota.createProject({ name: projectName });
    console.log(`Created project ${project.name} (${project.id}), slug=${project.slug}`);
  } catch (err) {
    console.error(
      `No project named "${projectName}" is visible to this key, and creating one was rejected ` +
        `(${err.statusCode ?? ''} ${err.message}). Either create a project named "${projectName}" ` +
        `in the sota.io dashboard, use an API key allowed to create projects, or set ` +
        `SOTA_PROJECT_ID to one of the project IDs listed above.`
    );
    process.exit(1);
  }
} else {
  console.log(`Deploying to existing project ${project.name} (${project.id}), slug=${project.slug}`);
}

execSync(
  "tar czf /tmp/sota-app.tar.gz --exclude=./.git --exclude=./node_modules --exclude=./dist --exclude=./.github .",
  { stdio: 'inherit' }
);

const deployment = await sota.deploy(project.id, readFileSync('/tmp/sota-app.tar.gz'));
console.log(`Deployment status: ${deployment.status}`);
console.log(`URL: ${deployment.url}`);
