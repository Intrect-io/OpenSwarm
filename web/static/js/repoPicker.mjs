// Repository dropdown fed by /api/local-projects. (INT-3388)

export class RepoPicker {
  #container;
  #onSelect;
  #select = null;

  constructor(container, { onSelect }) {
    this.#container = container;
    this.#onSelect = onSelect;
  }

  async load(fetchProjects) {
    const projects = await fetchProjects();
    const list = Array.isArray(projects) ? projects : (projects?.projects ?? []);

    const select = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select repository…';
    select.appendChild(placeholder);

    for (const project of list) {
      const path = typeof project === 'string' ? project : project.path;
      if (!path) continue;
      const option = document.createElement('option');
      option.value = path;
      option.textContent = typeof project === 'object' && project.name
        ? `${project.name} — ${path}`
        : path;
      select.appendChild(option);
    }

    select.addEventListener('change', () => {
      if (select.value) this.#onSelect(select.value);
    });

    this.#container.replaceChildren(select);
    this.#select = select;
  }

  get value() {
    return this.#select?.value || '';
  }
}
