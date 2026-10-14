const fragments = [
  ['app-header', '../partials/header.html'],
  ['app-workspace', '../partials/workspace.html'],
  ['app-overview', '../partials/overview.html'],
  ['app-modals', '../partials/modals.html']
];

async function loadFragment([targetId, path]) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) {
    throw new Error(`Unable to load ${path}: ${response.status} ${response.statusText}`);
  }
  const target = document.getElementById(targetId);
  if (!target) throw new Error(`Missing page mount point: #${targetId}`);
  target.innerHTML = await response.text();
}

try {
  await Promise.all(fragments.map(loadFragment));
  await import('./app.js');
} catch (error) {
  console.error('Application startup failed:', error);
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = `The application could not start: ${error.message}`;
  document.body.replaceChildren(message);
}
