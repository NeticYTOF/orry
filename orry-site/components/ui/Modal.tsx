"use client";
/* A button that opens a native modal <dialog> (class dlg): the page behind goes inert, Tab stays inside, Esc and a click on
   the backdrop close it, focus returns to the button. The body is server-rendered content passed as children.
   Use it for anything that would otherwise crowd a page: a form, a table, a long list, a chart. */
import { useId, useRef, type ReactNode } from "react";

export function Modal({ label, title, children, triggerClass = "btn sm", wide = false, footer }: {
  label: ReactNode; title: ReactNode; children: ReactNode; triggerClass?: string; wide?: boolean; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  const close = () => ref.current?.close();
  return (
    <>
      <button type="button" className={triggerClass} aria-haspopup="dialog" onClick={() => ref.current?.showModal()}>{label}</button>
      <dialog ref={ref} className={"dlg" + (wide ? " wide" : "")} aria-labelledby={tid} onClick={e => { if (e.target === e.currentTarget) close(); }}>
        <div className="dlg-head">
          <h2 id={tid}>{title}</h2>
          <button type="button" className="btn sm" onClick={close}>Close</button>
        </div>
        <div className="dlg-b">{children}</div>
        {footer ? <div className="dlg-f">{footer}</div> : null}
      </dialog>
    </>
  );
}
