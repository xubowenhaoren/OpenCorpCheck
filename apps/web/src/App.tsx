import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { CompanyPage } from "./pages/CompanyPage";
import { GraphPage } from "./pages/GraphPage";
import { HomePage } from "./pages/HomePage";
import { IndexPage } from "./pages/IndexPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SearchPage } from "./pages/SearchPage";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="c/:ref" element={<CompanyPage />} />
        <Route path="c/:ref/:tab" element={<CompanyPage />} />
        <Route path="graph" element={<GraphPage />} />
        <Route path="indices/:code" element={<IndexPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
