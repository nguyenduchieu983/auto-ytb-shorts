import { open, stat } from 'node:fs/promises';
import { Config } from '../config';
import { Repository } from '../db';
import { Metadata, PermanentError, UploadUncertainError, Work } from '../domain';

export class YoutubeProvider {
  private access?: { value: string; expires: number };
  constructor(
    private c: Config,
    private repo: Repository,
  ) {}
  private async token(): Promise<string> {
    if (this.access && this.access.expires > Date.now() + 60000) return this.access.value;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.c.GOOGLE_CLIENT_ID,
        client_secret: this.c.GOOGLE_CLIENT_SECRET,
        refresh_token: this.c.YOUTUBE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      await r.text();
      throw new PermanentError(
        `Google OAuth refresh HTTP ${r.status}; reauthorize if token was revoked`,
      );
    }
    const data: any = await r.json();
    if (!data.access_token) throw new PermanentError('Missing Google access token');
    this.access = {
      value: data.access_token,
      expires: Date.now() + Number(data.expires_in) * 1000,
    };
    return this.access.value;
  }
  private sessionAllowed(uri: string) {
    const u = new URL(uri);
    if (
      u.protocol !== 'https:' ||
      u.hostname !== 'www.googleapis.com' ||
      !u.pathname.startsWith('/upload/youtube/')
    )
      throw new PermanentError('Invalid resumable upload URI');
  }
  async publish(w: Work, path: string, metadata: Metadata, mock: boolean) {
    const saved = await this.repo.upload(w);
    if (saved?.youtube_video_id)
      return {
        video_id: saved.youtube_video_id,
        url: `https://www.youtube.com/watch?v=${saved.youtube_video_id}`,
        privacy: saved.response?.status?.privacyStatus || this.c.YOUTUBE_PRIVACY_STATUS,
        mock: this.c.MOCK_YOUTUBE,
      };
    if (this.c.MOCK_YOUTUBE) {
      const id = `mock-${w.runId}-r${w.revision}`;
      await this.repo.saveUpload(w, 'UPLOADED', null, id, { status: { privacyStatus: 'private' } });
      return { video_id: id, url: null, privacy: 'private', mock: true };
    }
    if (mock) throw new PermanentError('Mock content cannot be uploaded to YouTube');
    const size = (await stat(path)).size;
    let session = saved?.session_uri as string | undefined;
    if (!session) {
      if (saved && saved.status !== 'REJECTED')
        throw new UploadUncertainError(
          'Upload initiation outcome is unknown; reconcile before starting another session',
        );
      const token = await this.token();
      await this.repo.saveUpload(w, 'INITIATING', null);
      let r: Response;
      try {
        r = await fetch(
          'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Length': String(size),
              'X-Upload-Content-Type': 'video/mp4',
            },
            body: JSON.stringify({
              snippet: {
                title: metadata.title,
                description: metadata.description,
                tags: metadata.tags,
                categoryId: '28',
              },
              status: {
                privacyStatus: this.c.YOUTUBE_PRIVACY_STATUS,
                selfDeclaredMadeForKids: false,
              },
            }),
            signal: AbortSignal.timeout(30000),
          },
        );
      } catch {
        throw new UploadUncertainError('Connection lost during upload initiation');
      }
      if (!r.ok) {
        await r.text();
        if (r.status >= 500) throw new UploadUncertainError(`Upload initiation HTTP ${r.status}`);
        await this.repo.saveUpload(w, 'REJECTED', null);
        throw new PermanentError(`YouTube upload initiation HTTP ${r.status}`);
      }
      session = r.headers.get('location') || undefined;
      if (!session)
        throw new UploadUncertainError('Upload initiated without a resumable session URI');
      this.sessionAllowed(session);
      await this.repo.saveUpload(w, 'UPLOADING', session);
    }
    this.sessionAllowed(session);
    const status = await this.request(session, new Uint8Array(), `bytes */${size}`);
    const result = await this.result(w, session, status);
    if (result) return result;
    let offset = this.offset(status, size);
    const file = await open(path, 'r');
    try {
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, size - offset));
        const read = await file.read(chunk, 0, chunk.length, offset);
        if (!read.bytesRead)
          throw new PermanentError('Video file ended before declared upload size');
        const r = await this.request(
          session,
          chunk.subarray(0, read.bytesRead),
          `bytes ${offset}-${offset + read.bytesRead - 1}/${size}`,
        );
        const complete = await this.result(w, session, r);
        if (complete) return complete;
        const next = this.offset(r, size);
        if (next <= offset)
          throw new Error('Upload made no progress; check resumable status on retry');
        offset = next;
      }
      throw new UploadUncertainError('All bytes received without a final video resource');
    } finally {
      await file.close();
    }
  }
  private async request(session: string, body: Uint8Array, range: string): Promise<Response> {
    const token = await this.token();
    const r = await fetch(session, {
      method: 'PUT',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(body.byteLength),
        'Content-Range': range,
      },
      body: body as any,
      signal: AbortSignal.timeout(120000),
    });
    if (r.status === 401) {
      this.access = undefined;
      await r.text();
      throw new Error('YouTube access token expired; refresh on retry');
    }
    if (r.status === 404 || r.status === 410) {
      await r.text();
      throw new UploadUncertainError(
        'Resumable session expired; reconcile uploaded videos before a new upload',
      );
    }
    if (r.status >= 500 || r.status === 429) {
      await r.text();
      throw new Error(`YouTube transient HTTP ${r.status}`);
    }
    if (r.status !== 308 && !r.ok) {
      await r.text();
      throw new PermanentError(`YouTube upload HTTP ${r.status}`);
    }
    return r;
  }
  private offset(r: Response, size: number): number {
    if (r.status !== 308) throw new UploadUncertainError('Unexpected upload status');
    const range = r.headers.get('range');
    if (!range) return 0;
    const end = range.match(/^bytes=0-(\d+)$/)?.[1];
    if (!end || Number(end) >= size) throw new UploadUncertainError('Invalid resumable byte range');
    return Number(end) + 1;
  }
  private async result(w: Work, session: string, r: Response) {
    if (r.status === 308) return null;
    const video: any = await r.json();
    if (!video.id) throw new UploadUncertainError('Missing video ID after upload');
    await this.repo.saveUpload(w, 'UPLOADED', session, video.id, video);
    return {
      video_id: video.id,
      url: `https://www.youtube.com/watch?v=${video.id}`,
      privacy: video.status?.privacyStatus || 'private',
      mock: false,
    };
  }
  async reconcile(w: Work, videoId: string) {
    if (this.c.MOCK_YOUTUBE) throw new PermanentError('Reconciliation requires live YouTube');
    const token = await this.token();
    const r = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status,snippet&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) },
    );
    if (!r.ok) throw new PermanentError(`YouTube reconciliation HTTP ${r.status}`);
    const data: any = await r.json(),
      video = data.items?.find((v: any) => v.id === videoId);
    if (!video) throw new PermanentError('Video ID could not be verified with channel OAuth');
    // Verify ownership separately: videos.list by ID alone can return public videos from other channels.
    const channelResponse = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=id&mine=true',
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) },
    );
    if (!channelResponse.ok) throw new PermanentError('Could not verify channel ownership');
    const channels: any = await channelResponse.json();
    if (!channels.items?.some((c: any) => c.id === video.snippet.channelId))
      throw new PermanentError('Video belongs to a different channel');
    await this.repo.saveUpload(w, 'UPLOADED', null, videoId, video);
    return {
      video_id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      privacy: video.status.privacyStatus,
      mock: false,
    };
  }
}
