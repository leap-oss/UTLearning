window.AppModules = window.AppModules || {};

window.AppModules.sourcesAndExtraction = {
  get unreviewedSourcesCount() {
    const sources = this.activeModule?.sources || [];
    return sources.filter((s) => s.needsReview).length;
  },

  sourceLabel(label) {
    const map = {
      rangkuman: 'Rangkuman',
      tes_formatif: 'Tes Formatif',
      materi: 'Materi',
    };
    return map[label] || label || 'Materi';
  },

  handleFileSelect(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const existingCount = (this.activeModule?.sources?.length || 0) + this.stagedFiles.length;
    files.forEach((file, idx) => {
      const previewUrl = URL.createObjectURL(file);
      this.stagedFiles.push({
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        previewUrl,
        label: 'materi',
        pageOrder: existingCount + idx + 1,
      });
    });

    event.target.value = '';
  },

  moveStagedFile(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= this.stagedFiles.length) return;
    const copy = [...this.stagedFiles];
    const [item] = copy.splice(index, 1);
    copy.splice(targetIndex, 0, item);
    copy.forEach((entry, i) => {
      entry.pageOrder = i + 1;
    });
    this.stagedFiles = copy;
  },

  removeStagedFile(index) {
    const item = this.stagedFiles[index];
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
    this.stagedFiles.splice(index, 1);
  },

  clearStagedFiles() {
    for (const item of this.stagedFiles) {
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    this.stagedFiles = [];
  },

  async submitSourceExtraction() {
    if (!this.activeModule || this.stagedFiles.length === 0) return;
    this.clearBanners();

    const jobLabel = `Mengekstrak teks & struktur ${this.stagedFiles.length} halaman BMP...`;
    this.startAiJobFeedback(jobLabel, 'Mengunggah & memproses halaman BMP…');

    const formData = new FormData();
    for (const item of this.stagedFiles) {
      formData.append('images', item.file);
      formData.append('labels', item.label);
      formData.append('pageOrders', String(item.pageOrder));
    }

    const idemKey = this.generateIdempotencyKey('extract');

    try {
      const res = await fetch(`/api/modules/${this.activeModule.id}/sources/extract`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': idemKey,
          Accept: 'application/json',
        },
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal mengirim gambar untuk diekstrak.');
      }

      this.clearStagedFiles();
      const targetModuleId = this.activeModule.id;
      await this.pollAiJobUntilDone(
        data.jobId,
        jobLabel,
        async (jobResult) => {
          const modIdToOpen = targetModuleId || jobResult?.resultRefs?.moduleId || jobResult?.targetId;
          if (modIdToOpen) {
            await this.openModule(modIdToOpen, 'sources');
          }
          await this.refreshSystemStatus();
          this.showNotice('Ekstraksi selesai! Silakan periksa hasil ekstraksi sebelum membuat Study Pack.');
        },
        async () => {
          if (this.activeModule?.id === targetModuleId && this.currentView === 'module') {
            try {
              const { ok, data } = await this.fetchJson(`/api/modules/${targetModuleId}`, { headers: { Accept: 'application/json' } });
              if (ok && data?.module) {
                this.activeModule = data.module;
              }
            } catch (_) { /* silent */ }
          }
        }
      );
    } catch (err) {
      this.clearPendingAiJobFeedback();
      this.showError(err instanceof Error ? err.message : 'Gagal menjalankan ekstraksi.');
    }
  },

  startEditSource(source) {
    this.editingSourceId = source.id;
    const ext = source.extractedContentJson || {};
    this.sourceEditForm = {
      label: source.label || 'materi',
      pageOrder: source.pageOrder || 1,
      pageTitle: ext.pageTitle || '',
      extractedText: ext.extractedText || '',
      formulasText: Array.isArray(ext.formulasOrTables) ? ext.formulasOrTables.join('\n') : '',
      needsReview: false,
    };
  },

  async saveSourceReview(sourceId, markReviewed = true) {
    this.savingSourceEdit = true;
    this.clearBanners();
    this.startAiJobFeedback(
      markReviewed ? 'Menyimpan koreksi & memverifikasi halaman BMP...' : 'Menyimpan perubahan hasil ekstraksi...',
      'Menyimpan ke server…',
      1
    );
    try {
      const formulasOrTables = String(this.sourceEditForm.formulasText || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          label: this.sourceEditForm.label,
          pageOrder: Number(this.sourceEditForm.pageOrder) || 1,
          pageTitle: this.sourceEditForm.pageTitle,
          extractedText: this.sourceEditForm.extractedText,
          formulasOrTables,
          needsReview: !markReviewed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal menyimpan review sumber.');
      }
      this.editingSourceId = null;
      await this.openModule(this.activeModule.id, 'sources');
      this.showNotice(
        markReviewed
          ? 'Hasil ekstraksi disimpan dan ditandai sudah direview.'
          : 'Perubahan ekstraksi disimpan.'
      );
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal menyimpan review.');
    } finally {
      this.savingSourceEdit = false;
      this.clearPendingAiJobFeedback();
    }
  },

  async quickApproveSource(source) {
    this.startAiJobFeedback(`Memverifikasi Halaman ${source.pageOrder}...`, 'Menyimpan status verifikasi…', 1);
    try {
      const res = await fetch(`/api/sources/${source.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ needsReview: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal menandai selesai review.');
      }
      await this.openModule(this.activeModule.id, 'sources');
      this.showNotice(`Halaman ${source.pageOrder} ditandai selesai direview.`);
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal memperbarui status sumber.');
    } finally {
      this.clearPendingAiJobFeedback();
    }
  },

  confirmDeleteSource(source) {
    const pageLabel = `Hal. ${source.pageOrder}${source.label ? ` (${source.label})` : ''}`;
    this.confirmDialog = {
      open: true,
      title: `Hapus ${pageLabel}?`,
      message: `Halaman ini akan dihapus permanen dari modul. Teks hasil ekstraksi akan hilang dan tidak bisa dikembalikan.`,
      confirmLabel: 'Ya, Hapus',
      processing: false,
      onConfirm: async () => {
        const res = await fetch(`/api/sources/${source.id}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 404) {
          throw new Error(data.message || 'Gagal menghapus sumber.');
        }
        if (this.activeModule && Array.isArray(this.activeModule.sources)) {
          this.activeModule.sources = this.activeModule.sources.filter((s) => s.id !== source.id);
        }
        await this.openModule(this.activeModule.id, 'sources');
        this.showNotice(`${pageLabel} berhasil dihapus.`);
      },
    };
  },
};
