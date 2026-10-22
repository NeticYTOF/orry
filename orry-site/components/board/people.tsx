/* DATA's PersonRef ("@handle", name or null) in the shell's Who / PersonText shape. Server-safe. */
import type { PersonRef } from "@/lib/people";
import { PersonText, Who, type WhoPerson } from "@/components/shell/Who";

export const toWho = (p: PersonRef): WhoPerson => ({ handle: p.handle ? p.handle.replace(/^@/, "") : p.id, name: p.name ?? "" });

/** A person inline: the name in names mode, "@handle" in usernames mode. */
export const Person = ({ p, bold }: { p: PersonRef; bold?: boolean }) => <PersonText p={toWho(p)} bold={bold} />;

/** A person in the .who markup: name over @handle, with an optional "you" tag. */
export const WhoRef = ({ p, you }: { p: PersonRef; you?: boolean }) => <Who p={toWho(p)} you={you ?? p.you} />;
