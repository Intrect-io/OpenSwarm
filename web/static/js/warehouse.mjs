import { mountShell } from './shell.mjs';
import { formatDateTime } from './format.mjs';

const entriesBody = document.querySelector('#entries');
const breadcrumbs = document.querySelector('#breadcrumbs');
const upButton = document.querySelector('#up');
const refreshButton = document.querySelector('#refresh');
const fileInput = document.querySelector('#file');
const fileLabel = document.querySelector('#file-label');
const overwriteInput = document.querySelector('#overwrite');
const uploadButton = document.querySelector('#upload');
const uploadDirectory = document.querySelector('#upload-directory');
const status = document.querySelector('#status');

const TOKEN_KEY = 'openswarm.webToken';

let currentPath = '';

function parts(path) {
  return path.split('/').filter(Boolean);
}

function joinPath(directory, name) {
  return [...parts(directory), name].join('/');
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

async function api(url, options) {
  const headers = new Headers(options?.headers);
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.set('X-OpenSwarm-Token', token);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* non-JSON */ }
    throw new Error(message);
  }
  return response;
}

function setStatus(message, kind = '') {
  status.className = `status-line status${kind ? ` is-${kind} ${kind}` : ''}`;
  status.textContent = message;
}

// Replacing a file is the one thing here an operator cannot take back, so the
// checkbox alone is not consent: the first click names the file that would be
// replaced and asks once more, in the page (§3.2 — no window.confirm).
let armedOverwrite = null;

function disarmOverwrite() {
  armedOverwrite = null;
  uploadButton.classList.remove('is-armed');
  uploadButton.textContent = 'Upload';
}

function renderBreadcrumbs() {
  breadcrumbs.replaceChildren();
  const root = document.createElement('button');
  root.type = 'button';
  root.textContent = 'warehouse';
  root.addEventListener('click', () => loadTree(''));
  breadcrumbs.append(root);
  const segments = parts(currentPath);
  segments.forEach((segment, index) => {
    const divider = document.createElement('span');
    divider.textContent = '/';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = segment;
    button.addEventListener('click', () => loadTree(segments.slice(0, index + 1).join('/')));
    breadcrumbs.append(divider, button);
  });
  upButton.disabled = segments.length === 0;
  uploadDirectory.textContent = `/${currentPath}`;
}

function downloadButton(path, name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'download';
  button.textContent = 'Download';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await api(`/api/warehouse/file?path=${encodeURIComponent(path)}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderEntries(entries) {
  entriesBody.replaceChildren();
  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5" class="empty">This folder is empty.</td>';
    entriesBody.append(row);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const name = document.createElement(entry.type === 'directory' ? 'button' : 'span');
    name.className = 'file-name';
    name.textContent = `${entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'} ${entry.name}`;
    if (entry.type === 'directory') name.addEventListener('click', () => loadTree(joinPath(currentPath, entry.name)));
    nameCell.append(name);
    const typeCell = document.createElement('td');
    typeCell.textContent = entry.type;
    const sizeCell = document.createElement('td');
    sizeCell.textContent = entry.type === 'directory' ? '—' : formatBytes(entry.size);
    const modifiedCell = document.createElement('td');
    modifiedCell.textContent = formatDateTime(entry.mtime);
    const actionCell = document.createElement('td');
    if (entry.type !== 'directory') actionCell.append(downloadButton(joinPath(currentPath, entry.name), entry.name));
    row.append(nameCell, typeCell, sizeCell, modifiedCell, actionCell);
    entriesBody.append(row);
  }
}

async function loadTree(path) {
  setStatus('');
  try {
    const response = await api(`/api/warehouse/tree?path=${encodeURIComponent(path)}`);
    const payload = await response.json();
    currentPath = path;
    renderBreadcrumbs();
    renderEntries(payload.entries);
  } catch (error) {
    entriesBody.innerHTML = `<tr><td colspan="5" class="empty error"></td></tr>`;
    entriesBody.querySelector('td').textContent = error.message;
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileLabel.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'Choose a file';
  uploadButton.disabled = !file;
  disarmOverwrite();
});

overwriteInput.addEventListener('change', () => {
  if (!overwriteInput.checked) disarmOverwrite();
});

uploadButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const target = joinPath(currentPath, file.name);
  if (overwriteInput.checked && armedOverwrite !== target) {
    armedOverwrite = target;
    uploadButton.classList.add('is-armed');
    uploadButton.textContent = 'Confirm overwrite';
    setStatus(`This replaces /${target} with the new file. Press again to go ahead.`, 'warning');
    return;
  }
  disarmOverwrite();
  uploadButton.disabled = true;
  uploadButton.setAttribute('aria-busy', 'true');
  setStatus('Uploading…', 'pending');
  try {
    const overwrite = overwriteInput.checked ? '&overwrite=true' : '';
    await api(`/api/warehouse/file?path=${encodeURIComponent(target)}${overwrite}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    setStatus(`Uploaded ${file.name}`, 'success');
    fileInput.value = '';
    fileLabel.textContent = 'Choose a file';
    overwriteInput.checked = false;
    await loadTree(currentPath);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    uploadButton.removeAttribute('aria-busy');
    uploadButton.disabled = !fileInput.files?.length;
  }
});

upButton.addEventListener('click', () => loadTree(parts(currentPath).slice(0, -1).join('/')));
refreshButton.addEventListener('click', () => loadTree(currentPath));
mountShell(document);
loadTree('');
