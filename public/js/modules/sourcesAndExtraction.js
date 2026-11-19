window.AppModules = window.AppModules || {};

(() => {
const ALLOWED_SOURCE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;

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

  normalizeIncomingImageFile(file, index = 0) {
    if (!file) return null;
    const rawType = String(file.type || '').toLowerCase();
    const mime = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
    const isGenericName = !file.name || /^image\.(png|jpe?g|webp)$/i.test(file.name);
    if (!isGenericName && mime === rawType) {
      return file;
    }
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const targetName = isGenericName ? `clipboard-${stamp}-${index + 1}.${ext}` : file.name;
    return new File([file], targetName, {
      type: mime || 'image/png',
      lastModified: file.lastModified || Date.now(),
    });
  },

  extractImagesFromInput(input, { allowAnyImage = false } = {}) {
    if (!input) return { accepted: [], rejectedCount: 0 };

    const rawList = [];
    if (input.items && typeof input.items.length === 'number') {
      for (const item of Array.from(input.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) rawList.push(f);
        }
      }
    }
    if (rawList.length === 0) {
      const fileSource = input.files ? input.files : input;
      if (fileSource && typeof fileSource.length === 'number') {
        rawList.push(...Array.from(fileSource));
      } else if (Array.isArray(input)) {
        rawList.push(...input);
      }
    }

    const accepted = [];
    let rejectedCount = 0;

    rawList.forEach((rawFile, idx) => {
      const rawType = String(rawFile.type || '').toLowerCase();
      const mime = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
      const isAllowed = allowAnyImage
        ? mime.startsWith('image/') || IMAGE_EXT_RE.test(rawFile.name || '')
        : ALLOWED_SOURCE_IMAGE_TYPES.has(mime) || (!mime && IMAGE_EXT_RE.test(rawFile.name || ''));

      if (isAllowed) {
        accepted.push(this.normalizeIncomingImageFile(rawFile, idx));
      } else {
        rejectedCount += 1;
      }
    });

    return { accepted, rejectedCount };
  },

  handleDropzoneDragLeave(event, stateKey) {
    if (event.relatedTarget && event.currentTarget?.contains(event.relatedTarget)) {
      return;
    }
    this[stateKey] = false;
  },

  stageSourceFiles(input, origin = 'picker') {
    const { accepted, rejectedCount } = this.extractImagesFromInput(input, { allowAnyImage: false });

    if (accepted.length === 0) {
      if (rejectedCount > 0) {
        this.showError('Hanya gambar JPEG, PNG, atau WebP yang didukung.');
      }
      return 0;
    }

    const MAX_STAGED_FILES = 40;
    const remainingSlots = MAX_STAGED_FILES - this.stagedFiles.length;
    if (remainingSlots <= 0) {
      this.showError(`Maksimal ${MAX_STAGED_FILES} gambar dalam satu antrean ekstraksi OCR.`);
      return 0;
    }

    const acceptedFiles = accepted.slice(0, remainingSlots);
    const existingCount = (this.activeModule?.sources?.length || 0) + this.stagedFiles.length;

    acceptedFiles.forEach((file, idx) => {
      const previewUrl = URL.createObjectURL(file);
      this.stagedFiles.push({
        id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        previewUrl,
        pageOrder: existingCount + idx + 1,
      });
    });

    if (accepted.length > remainingSlots) {
      this.showError(
        `Maksimal ${MAX_STAGED_FILES} gambar per antrean ekstraksi. ${accepted.length - remainingSlots} gambar terakhir tidak dimasukkan.`
      );
    } else if (rejectedCount > 0) {
      this.showError(`${acceptedFiles.length} gambar ditambahkan, ${rejectedCount} file non-gambar diabaikan.`);
    } else if (origin === 'paste') {
      this.showNotice(
        `${acceptedFiles.length} gambar ditempel dari clipboard (total antrean ${this.stagedFiles.length}/${MAX_STAGED_FILES}).`
      );
    } else if (origin === 'drop') {
      this.showNotice(
        `${acceptedFiles.length} gambar ditambahkan lewat drag & drop (total antrean ${this.stagedFiles.length}/${MAX_STAGED_FILES}).`
      );
    }

    return acceptedFiles.length;
  },

  handleFileSelect(event) {
    const files = event.target?.files;
    if (files && files.length > 0) {
      this.stageSourceFiles(files, 'picker');
    }
    if (event.target) {
      event.target.value = '';
    }
  },

  handleSourceDrop(event) {
    this.isSourceDragOver = false;
    this.stageSourceFiles(event.dataTransfer, 'drop');
  },

  async pasteSourceFromClipboard() {
    if (!navigator.clipboard?.read) {
      this.showError('Browser tidak mendukung tombol tempel otomatis. Silakan tekan Ctrl+V langsung pada halaman ini.');
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files = [];
      for (const item of clipboardItems) {
        const mime = item.types.find((t) => ALLOWED_SOURCE_IMAGE_TYPES.has(t));
        if (!mime) continue;
        const blob = await item.getType(mime);
        const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
        files.push(new File([blob], `clipboard-${Date.now()}-${files.length + 1}.${ext}`, { type: mime }));
      }
      if (files.length === 0) {
        this.showError('Clipboard tidak berisi gambar (PNG/JPEG/WebP). Ambil tangkapan layar dulu lalu coba lagi.');
        return;
      }
      this.stageSourceFiles(files, 'paste');
    } catch {
      this.showError('Akses tombol clipboard diblokir browser. Cukup tekan Ctrl+V langsung pada halaman ini.');
    }
  },

  handleGlobalImagePaste(event) {
    if (this.showCourseModal || this.showModuleModal || this.confirmDialog?.open) {
      return;
    }
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const isModuleSourcesView =
      this.currentView === 'module' && this.moduleTab === 'sources' && Boolean(this.activeModule);
    const isEmptyCourseTocView =
      this.currentView === 'course' &&
      Boolean(this.activeCourse) &&
      (!this.activeCourse.modules || this.activeCourse.modules.length === 0) &&
      !this.isAutoMappingToc;

    if (!isModuleSourcesView && !isEmptyCourseTocView) {
      return;
    }

    const { accepted } = this.extractImagesFromInput(clipboard, {
      allowAnyImage: isEmptyCourseTocView,
    });
    if (accepted.length === 0) {
      return;
    }

    event.preventDefault();
    if (isModuleSourcesView) {
      this.stageSourceFiles(accepted, 'paste');
    } else if (isEmptyCourseTocView) {
      this.handleTocImageUpload({ target: { files: accepted, value: '' } });
    }
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

  buildExtractionBatches(items, maxImagesPerBatch = 15, maxBytesPerBatch = 3_800_000) {
    const batches = [];
    let current = [];
    let currentBytes = 0;

    for (const item of items || []) {
      const fileSize = Number(item?.file?.size) || 0;
      const wouldExceedCount = current.length >= maxImagesPerBatch;
      const wouldExceedBytes = current.length > 0 && currentBytes + fileSize > maxBytesPerBatch;
      if (wouldExceedCount || wouldExceedBytes) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += fileSize;
    }

    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  },

  async submitSourceExtraction() {
    if (!this.activeModule || this.stagedFiles.length === 0) return;
    this.clearBanners();

    const targetModuleId = this.activeModule.id;
    const queuedSnapshot = [...this.stagedFiles];
    const totalCount = queuedSnapshot.length;
    const batches = this.buildExtractionBatches(queuedSnapshot, 15, 3_800_000);
    const initialLabel =
      batches.length > 1
        ? `Batch 1/${batches.length} — mengekstrak ${batches[0].length} dari ${totalCount} halaman BMP...`
        : `Mengekstrak teks & struktur ${totalCount} halaman BMP...`;
    this.startAiJobFeedback(initialLabel, 'Mengunggah & memproses halaman BMP…');

    let extractedPagesTotal = 0;
    const refreshSourcesProgress = async () => {
      if (this.activeModule?.id === targetModuleId && this.currentView === 'module') {
        try {
          const { ok, data } = await this.fetchJson(`/api/modules/${targetModuleId}`, {
            headers: { Accept: 'application/json' },
          });
          if (ok && data?.module) {
            this.activeModule = data.module;
          }
        } catch (_) {
          /* silent */
        }
      }
    };

    try {
      for (let bIdx = 0; bIdx < batches.length; bIdx += 1) {
        const batch = batches[bIdx];
        const batchLabel =
          batches.length > 1
            ? `Batch ${bIdx + 1}/${batches.length} — mengekstrak ${batch.length} dari ${totalCount} halaman BMP...`
            : `Mengekstrak teks & struktur ${totalCount} halaman BMP...`;

        this.startAiJobFeedback(
          batchLabel,
          batches.length > 1
            ? `Mengunggah batch ${bIdx + 1}/${batches.length} (aman untuk Vercel)…`
            : 'Mengunggah & memproses halaman BMP…'
        );

        const formData = new FormData();
        for (const item of batch) {
          formData.append('images', item.file);
          formData.append('pageOrders', String(item.pageOrder));
        }

        const idemKey = this.generateIdempotencyKey(`extract-b${bIdx + 1}`);
        const { ok, status, data } = await this.fetchJson(
          `/api/modules/${targetModuleId}/sources/extract`,
          {
            method: 'POST',
            headers: {
              'Idempotency-Key': idemKey,
              Accept: 'application/json',
            },
            body: formData,
          },
          0
        );

        if (!ok) {
          throw new Error(
            this.extractApiErrorMessage(data, status, 'Gagal mengirim gambar untuk diekstrak.')
          );
        }

        await this.waitForAiJobCompletion(data.jobId, batchLabel, refreshSourcesProgress);

        const completedIds = new Set(batch.map((item) => item.id));
        for (const item of batch) {
          if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
        this.stagedFiles = this.stagedFiles.filter((item) => !completedIds.has(item.id));
        extractedPagesTotal += batch.length;

        if (bIdx < batches.length - 1) {
          await refreshSourcesProgress();
        }
      }

      this.activeAiJob = null;
      await this.openModule(targetModuleId, 'sources');
      await this.refreshSystemStatus();
      this.showNotice(
        `Ekstraksi ${extractedPagesTotal} halaman selesai! Silakan periksa hasil ekstraksi sebelum membuat Study Pack.`
      );
    } catch (err) {
      this.activeAiJob = null;
      await refreshSourcesProgress();
      await this.refreshSystemStatus();
      const baseErr = err instanceof Error ? err.message : 'Gagal menjalankan ekstraksi.';
      this.showError(
        extractedPagesTotal > 0
          ? `${extractedPagesTotal} halaman awal berhasil disimpan, namun batch berikutnya gagal: ${baseErr} Sisa gambar masih di antrean — klik Ekstrak halaman lagi untuk melanjutkan.`
          : baseErr
      );
    } finally {
      this.activeAiJob = null;
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
})();
