import type { FlowId, ModelId, PartyId } from '../../../server/src/domain.ts';

// Static Indonesian copy from the approved prototype. Party names come from /api/meta, never from here.
export const GROUPS: [string, string, FlowId[]][] = [
  ['rd', 'Rupiah Digital (RD)', ['rd-issue', 'rd-transfer']],
  ['dfabi', 'Obligasi DFABI', ['dfabi-issue', 'dfabi-transfer']],
  ['dvp', 'Penyelesaian DvP', ['dvp']],
];
export const FLOW_NAME: Record<FlowId, string> = {
  'rd-issue': 'Penerbitan RD',
  'rd-transfer': 'Transfer RD',
  'dfabi-issue': 'Penerbitan seri DFABI',
  'dfabi-transfer': 'Transfer DFABI',
  dvp: 'DvP DFABI ↔ RD',
};
export const groupName = (flow: FlowId) => GROUPS.find((g) => g[2].includes(flow))![1];
export const flowName = (_model: ModelId, flow: FlowId) => FLOW_NAME[flow];

export const MODEL_COPY: Record<ModelId, { tag: string; story: string }> = {
  zeto: {
    tag: 'Bukti zero-knowledge. Nominal dan pihak tidak tercatat terbuka di chain.',
    story: 'Chain hanya menyimpan commitment dan bukti ZK. Bank membaca dari node Paladin masing-masing. BI membaca laporan bank lalu mencocokkannya dengan commitment on-chain, sehingga laporan palsu atau yang ditahan ketahuan.',
  },
  noto: {
    tag: 'BI sebagai notary. Setiap transaksi wajib ditandatangani BI.',
    story: 'BI bertindak sebagai notary sehingga selalu memegang salinan cleartext. Bank lain di network hanya melihat hash state, dan permintaan baca dari node yang bukan anggota ditolak.',
  },
  stealth: {
    tag: 'Alamat sekali pakai. Identitas bank tersembunyi, nominal tetap publik.',
    story: 'Penerima memakai alamat sekali pakai dan identitas pengirim dienkripsi di memo. BI memegang view key semua bank sehingga bisa memetakan setiap transaksi. Nominal tetap terlihat publik di chain.',
  },
};

export const nodeLabel = (model: ModelId, node: number) => (model === 'stealth' ? 'Akun Besu' : `Paladin node ${node}`);
export const roleHelp = (issuer: boolean, dvp: boolean) =>
  issuer ? 'Penerbitan hanya dijalankan BI.' : dvp ? 'Pilih bank penjual DFABI.' : 'Pilih bank pengirim.';

export const VERDICT: Record<string, { cls: 'clear' | 'partial' | 'sealed'; icon: 'eye' | 'half' | 'lock'; text: string }> = {
  clear: { cls: 'clear', icon: 'eye', text: 'Terbaca utuh' },
  reported: { cls: 'clear', icon: 'eye', text: 'Laporan terverifikasi' },
  notarised: { cls: 'clear', icon: 'eye', text: 'Ditandatangani BI' },
  viewkey: { cls: 'clear', icon: 'eye', text: 'Dipetakan via view key' },
  partial: { cls: 'partial', icon: 'half', text: 'Nominal terlihat, pihak tidak' },
  sealed: { cls: 'sealed', icon: 'lock', text: 'Tersegel' },
};

export const roleLabel = (role: string, dvp: boolean) =>
  ({
    issuer: 'Penerbit & pengawas',
    sender: dvp ? 'Penjual DFABI' : 'Pengirim',
    receiver: dvp ? 'Pembeli DFABI' : 'Penerima',
    regulator: 'Pengawas',
    outsider: 'Tidak terlibat',
  })[role] ?? role;

export const PARTY_ORDER: PartyId[] = ['A', 'B', 'C', 'BI'];
