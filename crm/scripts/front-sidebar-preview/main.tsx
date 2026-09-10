import { createRoot } from "react-dom/client";
import FrontSidebar from "../../src/pages/FrontSidebar";
import "../../src/styles.css";
const panel = new URLSearchParams(location.search).get("panel");
createRoot(document.getElementById("root")!).render(panel ? <FrontSidebar /> : <div style={{ padding: 24 }}>
  <h1 style={{ fontSize: 22, color: "#142a4c" }}>Front lead workspace</h1><p>Fictional preview. Forms here do not send messages or change CRM data.</p>
  <div style={{ display: "flex", flexWrap: "wrap", gap: 32 }}>{[260, 340, 440].map(width => <section key={width}><h2 style={{ fontSize: 14 }}>{width}px panel</h2><iframe title={`${width}px Front panel`} src={`?panel=${width}`} width={width} height={1100} style={{ border: "1px solid #dfe4ec", borderRadius: 10 }} /></section>)}</div>
</div>);
