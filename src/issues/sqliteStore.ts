// ============ 이슈 CRUD ============

  createIssue(input: CreateIssueInput): Issue {
    const id = input.id ?? nanoid(12);

    // If a caller-provided id is given, check for an existing issue first.
    // This makes repeated calls with the same id idempotent.
    if (input.id) {
      const existing = this.getIssue(id);
      if (existing) return existing;
    }

    const now = new Date().toISOString();

    const insertIssue = this.db.prepare(`
      INSERT INTO issues (id, project_id, title, description, status, priority, source,
        assignee, milestone, estimate_minutes, complexity, parent_id,
        linear_id, linear_identifier, linear_url, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLabel = this.db.prepare(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)'
    );
    const insertDep = this.db.prepare(
      'INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)'
    );
    const insertFile = this.db.prepare(
      'INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)'
    );
    const insertCriteria = this.db.prepare(
      'INSERT INTO issue_acceptance_criteria (issue_id, criterion, sort_order) VALUES (?, ?, ?)'
    );
    const insertEvent = this.db.prepare(`
      INSERT INTO issue_events (id, issue_id, type, new_value, actor, created_at)
      VALUES (?, ?, 'created', ?, 'system', ?)
    `);
    // 부모 이슈의 child 목록은 쿼리 시 동적 조회

    const transaction = this.db.transaction(() => {
      insertIssue.run(
        id, input.projectId, input.title, input.description ?? '',
        input.status ?? 'backlog', input.priority ?? 'medium', input.source ?? 'local',
        input.assignee ?? null, input.milestone ?? null,
        input.estimateMinutes ?? null, input.complexity ?? null,
        input.parentId ?? null,
        input.linearId ?? null, input.linearIdentifier ?? null, input.linearUrl ?? null,
        now, now, input.status === 'done' || input.status === 'cancelled' ? now : null,
      );

      for (const label of input.labels ?? []) {
        const labelId = this.ensureLabelId(label);
        if (labelId) insertLabel.run(id, labelId);
      }
      for (const depId of input.dependencies ?? []) {
        insertDep.run(id, depId);
      }
      for (const filePath of input.relevantFiles ?? []) {
        insertFile.run(id, filePath);
      }
      for (let i = 0; i < (input.acceptanceCriteria ?? []).length; i++) {
        insertCriteria.run(id, input.acceptanceCriteria![i], i);
      }

      insertEvent.run(nanoid(12), id, input.title, now);
    });

    transaction();
    return this.getIssue(id)!;
  }