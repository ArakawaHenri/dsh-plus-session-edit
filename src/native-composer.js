// DSH 0.2.1-rc.2 has no primary-action slot. Keep its InputBar mounted and
// borrow the native action's position/classes only for empty-draft continuation.
// The right-hand slot and data-composer-card are owned by that same InputBar.
export function useNativePrimary(React, marker, sessionId) {
  const [anchor, setAnchor] = React.useState(null);
  React.useLayoutEffect(() => {
    const card = marker.current?.closest('[data-composer-card]');
    if (!card) return;
    const update = () => {
      const button = [...card.querySelectorAll('button')].findLast(
        item =>
          !item.closest('[data-session-edit-control]') &&
          item.parentElement.contains(marker.current),
      );
      const editor = card.querySelector('[contenteditable]');
      const editable = editor?.getAttribute('contenteditable') === 'true';
      const next = button
        ? { button, parent: button.parentElement, className: button.className, editable, disabled: button.disabled }
        : null;
      setAnchor(previous =>
        previous?.button === next?.button &&
        previous?.parent === next?.parent &&
        previous?.className === next?.className &&
        previous?.editable === next?.editable &&
        previous?.disabled === next?.disabled
          ? previous
          : next,
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(card, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'contenteditable', 'class'],
    });
    return () => observer.disconnect();
  }, [sessionId]);
  return anchor;
}

export function usePrimaryReplacement(React, anchor, active) {
  React.useLayoutEffect(() => {
    if (!active || !anchor) return;
    anchor.button.setAttribute('data-session-edit-suppressed', '');
    return () => anchor.button.removeAttribute('data-session-edit-suppressed');
  }, [anchor?.button, active]);
}
