import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, onSnapshot, setDoc, type Unsubscribe } from 'firebase/firestore';
import { authPersistenceReady, firebaseAuth, googleProvider, ownerFirestore } from '../firebase';
import { resolveOwnerVault } from '../owner-vault';
import {
  applyRemoteRadarRecord,
  hasMeaningfulRadarRecord,
  loadRadarVaultRecord,
  parseRadarVaultRecord,
  saveState,
  subscribeRadarState,
  type RadarVaultRecord,
} from './store';
import {
  applyRemoteStudiesState,
  hasMeaningfulStudiesState,
  loadStudiesState,
  parseStudiesState,
  subscribeStudiesState,
  type StudiesPersonalState,
} from '@/studies/personal-state.ts';

export type VaultSyncStatus =
  | { state: 'connecting' }
  | { state: 'signed-out' }
  | { state: 'syncing'; email?: string }
  | { state: 'synced'; email?: string }
  | { state: 'error'; message: string; email?: string };

type StatusListener = (status: VaultSyncStatus) => void;
const listeners = new Set<StatusListener>();
let currentStatus: VaultSyncStatus = { state: 'connecting' };
let started = false;

function publish(status: VaultSyncStatus): void {
  currentStatus = status;
  for (const listener of [...listeners]) listener(status);
}

function compareRecords(a: RadarVaultRecord, b: RadarVaultRecord): number {
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
  return a.clientId.localeCompare(b.clientId);
}

function laterVisit(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function compareStudies(a: StudiesPersonalState, b: StudiesPersonalState): number {
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
  return a.clientId.localeCompare(b.clientId);
}

export function subscribeVaultStatus(listener: StatusListener): () => void {
  listeners.add(listener);
  listener(currentStatus);
  return () => listeners.delete(listener);
}

export function startRadarVaultSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  let authRevision = 0;
  let stopSnapshot: Unsubscribe | null = null;
  let stopState: (() => void) | null = null;
  let stopStudiesSnapshot: Unsubscribe | null = null;
  let stopStudiesState: (() => void) | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let studiesWriteTimer: ReturnType<typeof setTimeout> | null = null;
  let activeVault: string | null = null;
  let vaultReady = false;
  let studiesReady = false;
  let applyingRemote = false;
  let applyingStudies = false;

  const teardown = () => {
    stopSnapshot?.();
    stopSnapshot = null;
    stopState?.();
    stopState = null;
    stopStudiesSnapshot?.();
    stopStudiesSnapshot = null;
    stopStudiesState?.();
    stopStudiesState = null;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    if (studiesWriteTimer) clearTimeout(studiesWriteTimer);
    studiesWriteTimer = null;
    activeVault = null;
    vaultReady = false;
    studiesReady = false;
  };

  const scheduleWrite = (record: RadarVaultRecord, email: string | undefined) => {
    if (!vaultReady || !activeVault || applyingRemote) return;
    if (writeTimer) clearTimeout(writeTimer);
    const targetVault = activeVault;
    const payload = structuredClone(record);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      publish({ state: 'syncing', ...(email ? { email } : {}) });
      void setDoc(doc(ownerFirestore, 'radar_vaults', targetVault), payload).then(() => {
        if (activeVault === targetVault) publish({ state: 'synced', ...(email ? { email } : {}) });
      }).catch((error: unknown) => {
        if (activeVault !== targetVault) return;
        publish({
          state: 'error',
          message: error instanceof Error ? error.message : 'Radar could not save to the owner vault.',
          ...(email ? { email } : {}),
        });
      });
    }, 500);
  };

  const scheduleStudiesWrite = (state: StudiesPersonalState, email: string | undefined) => {
    if (!studiesReady || !activeVault || applyingStudies) return;
    if (studiesWriteTimer) clearTimeout(studiesWriteTimer);
    const targetVault = activeVault;
    const payload = structuredClone(state);
    studiesWriteTimer = setTimeout(() => {
      studiesWriteTimer = null;
      void setDoc(doc(ownerFirestore, 'studies_vaults', targetVault), payload).then(() => {
        if (activeVault === targetVault) publish({ state: 'synced', ...(email ? { email } : {}) });
      }).catch((error: unknown) => {
        if (activeVault !== targetVault) return;
        publish({
          state: 'error',
          message: error instanceof Error ? error.message : 'Studies could not save to the owner vault.',
          ...(email ? { email } : {}),
        });
      });
    }, 500);
  };

  void authPersistenceReady.catch(() => undefined).then(() => {
    onAuthStateChanged(firebaseAuth, (user) => {
      const revision = ++authRevision;
      teardown();
      if (!user) {
        publish({ state: 'signed-out' });
        return;
      }
      const email = user.email ?? undefined;
      publish({ state: 'syncing', ...(email ? { email } : {}) });
      void resolveOwnerVault(ownerFirestore, user).then((membership) => {
        if (revision !== authRevision || firebaseAuth.currentUser !== user) return;
        activeVault = membership.vaultId;
        const reference = doc(ownerFirestore, 'radar_vaults', membership.vaultId);
        const studiesReference = doc(ownerFirestore, 'studies_vaults', membership.vaultId);
        stopState = subscribeRadarState((_state, record) => scheduleWrite(record, email));
        stopStudiesState = subscribeStudiesState((state) => scheduleStudiesWrite(state, email));
        stopSnapshot = onSnapshot(reference, (snapshot) => {
          if (revision !== authRevision || activeVault !== membership.vaultId) return;
          const local = loadRadarVaultRecord();
          const remote = snapshot.exists() ? parseRadarVaultRecord(snapshot.data()) : null;
          vaultReady = true;
          if (!remote) {
            if (hasMeaningfulRadarRecord(local)) scheduleWrite(local, email);
            else publish({ state: 'synced', ...(email ? { email } : {}) });
            return;
          }

          if (compareRecords(local, remote) > 0) {
            scheduleWrite(local, email);
            return;
          }

          const latestVisit = laterVisit(local.state.lastVisit, remote.state.lastVisit);
          applyingRemote = true;
          try {
            applyRemoteRadarRecord(remote);
          } finally {
            applyingRemote = false;
          }
          if (latestVisit !== remote.state.lastVisit) {
            saveState({ ...remote.state, lastVisit: latestVisit });
          } else {
            publish({ state: 'synced', ...(email ? { email } : {}) });
          }
        }, (error) => {
          if (revision !== authRevision) return;
          publish({ state: 'error', message: error.message, ...(email ? { email } : {}) });
        });
        stopStudiesSnapshot = onSnapshot(studiesReference, (snapshot) => {
          if (revision !== authRevision || activeVault !== membership.vaultId) return;
          const local = loadStudiesState();
          const remote = snapshot.exists() ? parseStudiesState(snapshot.data()) : null;
          studiesReady = true;
          if (!remote) {
            if (hasMeaningfulStudiesState(local)) scheduleStudiesWrite(local, email);
            return;
          }
          if (compareStudies(local, remote) > 0) {
            scheduleStudiesWrite(local, email);
            return;
          }
          applyingStudies = true;
          try {
            applyRemoteStudiesState(remote);
          } finally {
            applyingStudies = false;
          }
        }, (error) => {
          if (revision !== authRevision) return;
          publish({ state: 'error', message: error.message, ...(email ? { email } : {}) });
        });
      }).catch((error: unknown) => {
        if (revision !== authRevision) return;
        publish({
          state: 'error',
          message: error instanceof Error ? error.message : 'This account cannot access the owner vault.',
          ...(email ? { email } : {}),
        });
      });
    });
  });
}

export async function signInToRadarVault(): Promise<void> {
  await authPersistenceReady;
  await signInWithPopup(firebaseAuth, googleProvider);
}

export async function signOutOfRadarVault(): Promise<void> {
  await signOut(firebaseAuth);
}
