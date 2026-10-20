import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { Avatar, Badge, Button, Card, CardIcon, Empty, ErrorBox, Field, Input, Loading, SectionTitle, SplitName, useToast } from "../components/ui";
import { formatDate } from "../format";
import { useMe } from "../hooks";
import type { Card as FineCard } from "../types";
import { AccountSections, useAccount, useCheckout } from "../components/account";
import { formatMoney } from "../../shared/rules";

/** Center-crop and resize to a 256px JPEG in the browser, so uploads stay small (~20–40 KB). */
async function resizeImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file couldn't be read as an image."));
      i.src = url;
    });
    const size = 256;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    canvas.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function MePage() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ displayName: "", contactPhone: "" });
  useEffect(() => {
    if (me?.player) setForm({ displayName: me.player.displayName, contactPhone: me.player.contactPhone ?? "" });
  }, [me?.player?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = useMutation({
    mutationFn: async (file: File) => api.req("PUT", `/players/${me!.player!.id}/avatar`, { dataUrl: await resizeImage(file) }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast("Photo updated");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const removePhoto = useMutation({
    mutationFn: () => api.req("DELETE", `/players/${me!.player!.id}/avatar`),
    onSuccess: () => qc.invalidateQueries(),
  });
  const save = useMutation({
    mutationFn: () => api.patch("/me/player", { displayName: form.displayName, contactPhone: form.contactPhone || null }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast("Profile saved");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const signOut = async () => {
    await api.post("/auth/sign-out", {}).catch(() => {});
    qc.clear();
    navigate("/signin");
  };

  if (isLoading) return <Loading />;
  const player = me?.player;
  return (
    <div className="space-y-8">
      {!player ? (
        <Empty title="No player profile">Your login isn't linked to a player yet. Ask an admin.</Empty>
      ) : (
        <>
          {!player.approved && (
            <div role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
              <b>Waiting for approval.</b> An admin will approve your account soon. You can add your photo now; you'll be able to mark availability once approved.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-5 border-b border-line pb-6">
            <Avatar name={player.displayName} url={player.avatarUrl} size={88} />
            <div className="space-y-3">
              <div>
                <h1 className="text-[34px] font-medium leading-tight tracking-[-0.035em] sm:text-[40px]"><SplitName name={player.displayName} /></h1>
                <div className="text-[15px] text-muted">{me?.user?.email} · {player.kind === "guest" ? "Guest" : "Member"}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) upload.mutate(f);
                    e.target.value = "";
                  }}
                />
                <Button size="sm" loading={upload.isPending} onClick={() => fileRef.current?.click()}>
                  {player.avatarUrl ? "Change photo" : "Upload photo"}
                </Button>
                {player.avatarUrl && (
                  <Button size="sm" variant="ghost" onClick={() => removePhoto.mutate()}>Remove</Button>
                )}
                <Link to={`/players/${player.id}`}><Button size="sm" variant="secondary">My stats</Button></Link>
              </div>
            </div>
          </div>
          <Card className="p-5">
            <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
              <Field label="Display name"><Input required maxLength={60} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
              <Field label="Phone" hint="Only admins can see it."><Input type="tel" maxLength={30} value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></Field>
              <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Save</Button></div>
            </form>
          </Card>
          <AccountSections />
          <Fines />
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {me?.user?.role === "admin" && <Link to="/admin"><Button variant="secondary">Admin area</Button></Link>}
        <Link to="/announcements"><Button variant="secondary">Announcements</Button></Link>
        <Link to="/rules"><Button variant="secondary">Rules</Button></Link>
        <Button variant="danger" onClick={signOut}>Sign out</Button>
      </div>
    </div>
  );
}

function Fines() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-fines"],
    queryFn: () => api.get<{ cards: FineCard[]; outstanding: number; currency: string; fines: { yellow: number; red: number } }>("/me/fines"),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const account = useAccount();
  const balance = account.data?.wallet.balance ?? 0;
  const [useWallet, setUseWallet] = useState(true);
  const checkout = useCheckout("/fines/checkout", "Fines paid with wallet credit");
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const unpaid = d.cards.filter((k) => k.fineStatus === "unpaid");
  const chosen = selected ?? new Set(unpaid.map((k) => k.id));
  const total = unpaid.filter((k) => chosen.has(k.id)).reduce((s, k) => s + k.fineAmount, 0);
  const walletPart = useWallet ? Math.min(balance, total) : 0;
  return (
    <section>
      <SectionTitle>Fines</SectionTitle>
      <p className="mb-3 text-sm text-muted">
        Yellow card {formatMoney(d.fines.yellow, d.currency)} · Red card {formatMoney(d.fines.red, d.currency)}
      </p>
      {d.cards.length === 0 ? (
        <Empty title="Clean record">No cards, no fines. Keep it up.</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {d.cards.map((k) => (
              <li key={k.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
                {k.fineStatus === "unpaid" && (
                  <input
                    type="checkbox"
                    aria-label="Include in payment"
                    className="size-5 accent-pitch-700"
                    checked={chosen.has(k.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(k.id);
                      else next.delete(k.id);
                      setSelected(next);
                    }}
                  />
                )}
                <CardIcon color={k.color} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium capitalize">{k.color} card {k.date && <span className="font-normal text-muted">· {formatDate(k.date)}</span>}</div>
                  {k.reason && <div className="truncate text-xs text-muted">{k.reason}</div>}
                </div>
                <span className="num font-semibold">{formatMoney(k.fineAmount, d.currency)}</span>
                <Badge tone={k.fineStatus === "paid" ? "green" : k.fineStatus === "waived" ? "gray" : "red"}>
                  {k.fineStatus === "paid" ? (k.paidVia === "cash" ? "Paid (cash)" : "Paid") : k.fineStatus === "waived" ? "Waived" : "Unpaid"}
                </Badge>
              </li>
            ))}
          </ul>
          {unpaid.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line p-4">
              <div className="flex-1">
                <div className="text-sm text-muted">Outstanding</div>
                <div className="num stat text-2xl text-red-700">{formatMoney(d.outstanding, d.currency)}</div>
              </div>
              {balance > 0 && (
                <label className="flex w-full items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="size-5 accent-pitch-700" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
                  Use wallet credit ({formatMoney(Math.min(balance, total), d.currency)})
                </label>
              )}
              <Button size="lg" disabled={total === 0} loading={checkout.isPending} onClick={() => checkout.mutate({ cardIds: [...chosen].filter((id) => unpaid.some((k) => k.id === id)), useWallet })}>
                {total - walletPart === 0 ? `Pay with wallet` : `Pay ${formatMoney(total - walletPart, d.currency)}`}
              </Button>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}
