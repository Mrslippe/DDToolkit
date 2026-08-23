import { useNavigate } from "react-router";
import { getPathByGuid } from "@/router/routes";
import { withStopPropagation } from "@/utils/utils";
import "@/styles/Frame4172.css";
const Frame4172 = () => {
    const navigate = useNavigate();

    const click_41_101 = () => {
        navigate(getPathByGuid("0:0"), {
            state: {
                from: "41:101",
                et: "c"
            }
        });
    };

    return (
        <div className="scroll-container">
            <div
                id="41_72"
                className="Pixso-frame-41_72 pixso-relative-no-shrink pixso-flex"
            >
                <div className="frame-content-41_72 pixso-relative-flex">
                    <div
                        id="41_73"
                        className="Pixso-frame-41_73 pixso-relative-no-shrink pixso-flex-auto-width"
                    >
                        <div className="frame-content-41_73 pixso-relative-flex">
                            <div
                                id="41_74"
                                className="Pixso-frame-41_74 pixso-relative-no-shrink pixso-flex"
                            >
                                <div className="frame-content-41_74 pixso-relative-flex">
                                    <div
                                        id="41_75"
                                        className="Pixso-group-41_75 pixso-relative-no-shrink"
                                    >
                                        <div
                                            id="41_77"
                                            className="Pixso-vector-41_77"
                                        ></div>
                                    </div>
                                </div>
                            </div>
                            <div
                                id="41_80"
                                className="Pixso-frame-41_80 pixso-relative-no-shrink pixso-transparent-flex"
                            >
                                <div className="frame-content-41_80 pixso-relative-flex">
                                    <div
                                        id="41_81"
                                        className="Pixso-group-41_81 pixso-relative-no-shrink"
                                    >
                                        <div
                                            id="41_83"
                                            className="Pixso-vector-41_83"
                                        ></div>
                                    </div>
                                </div>
                            </div>
                            <div
                                id="41_87"
                                className="Pixso-frame-41_87 pixso-relative-no-shrink pixso-transparent-flex"
                            >
                                <div className="frame-content-41_87 pixso-relative-flex">
                                    <div
                                        id="41_88"
                                        className="Pixso-group-41_88 pixso-relative-no-shrink"
                                    >
                                        <div
                                            id="41_90"
                                            className="Pixso-vector-41_90"
                                        ></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div
                        id="41_95"
                        className="Pixso-frame-41_95 pixso-relative-no-shrink pixso-flex-auto-width"
                    >
                        <div className="frame-content-41_95 pixso-relative-flex">
                            <div
                                id="41_96"
                                className="Pixso-frame-41_96 pixso-relative-no-shrink pixso-transparent-flex"
                            >
                                <div className="frame-content-41_96 pixso-relative-flex">
                                    <div
                                        id="41_97"
                                        className="Pixso-vector-41_97 pixso-relative-no-shrink"
                                    ></div>
                                </div>
                            </div>
                            <div
                                id="41_100"
                                className="Pixso-frame-41_100 pixso-relative-no-shrink pixso-transparent-flex"
                            >
                                <div className="frame-content-41_100 pixso-relative-flex">
                                    <div
                                        id="41_101"
                                        className="Pixso-group-41_101 pixso-relative-no-shrink"
                                        onClick={withStopPropagation(
                                            click_41_101
                                        )}
                                    >
                                        <div
                                            id="41_103"
                                            className="Pixso-vector-41_103"
                                        ></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
export default Frame4172;
