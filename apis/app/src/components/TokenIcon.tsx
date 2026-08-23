import { TOKEN_COLOR, TOKEN_ICON, TOKEN_ICON_TEXT, type AnyTokenSymbol } from '../tokenVisuals';

/// 1:1 dieselbe Komponente wie OSIRIS' eigene TokenIcon() (siehe src/App.tsx)
/// — farbiger Kreis mit Symbol, Größe/Farben identisch parametrisiert.
export default function TokenIcon({ token, size = 20 }: { token: AnyTokenSymbol; size?: number }) {
  return (
    <span
      className="token-icon"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.55,
        background: TOKEN_COLOR[token],
        color: TOKEN_ICON_TEXT[token],
      }}
    >
      {TOKEN_ICON[token]}
    </span>
  );
}
