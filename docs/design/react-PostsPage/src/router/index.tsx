import RouterViewContext from "./components/StaticWrapper";

import {
  BrowserRouter as Router,
} from "react-router";

export const RouterView = () => {
  return (
    <Router>
      <RouterViewContext />
    </Router>
  );
};
