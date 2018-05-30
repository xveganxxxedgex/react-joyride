import React from 'react';
import PropTypes from 'prop-types';
import treeChanges from 'tree-changes';
import is from 'is-lite';

import Store from '../modules/store';
import {
  getElement,
  getScrollTo,
  getScrollParent,
  hasCustomScrollParent,
  isFixed,
  scrollTo,
} from '../modules/dom';
import { canUseDOM, isEqual, log } from '../modules/helpers';
import { getMergedStep, validateSteps } from '../modules/step';

import ACTIONS from '../constants/actions';
import EVENTS from '../constants/events';
import LIFECYCLE from '../constants/lifecycle';
import STATUS from '../constants/status';

import Step from './Step';

class Joyride extends React.Component {
  constructor(props) {
    super(props);

    this.store = new Store({
      ...props,
      controlled: props.run && is.number(props.stepIndex),
    });
    this.state = this.store.getState();
    this.helpers = this.store.getHelpers();
  }

  static propTypes = {
    beaconComponent: PropTypes.oneOfType([
      PropTypes.func,
      PropTypes.element,
    ]),
    callback: PropTypes.func,
    continuous: PropTypes.bool,
    debug: PropTypes.bool,
    disableCloseOnEsc: PropTypes.bool,
    disableOverlay: PropTypes.bool,
    disableOverlayClose: PropTypes.bool,
    disableScrolling: PropTypes.bool,
    floaterProps: PropTypes.shape({
      offset: PropTypes.number,
    }),
    hideBackButton: PropTypes.bool,
    locale: PropTypes.object,
    run: PropTypes.bool,
    scrollOffset: PropTypes.number,
    scrollToFirstStep: PropTypes.bool,
    showProgress: PropTypes.bool,
    showSkipButton: PropTypes.bool,
    spotlightClicks: PropTypes.bool,
    spotlightPadding: PropTypes.number,
    stepIndex: PropTypes.number,
    steps: PropTypes.array,
    styles: PropTypes.object,
    tooltipComponent: PropTypes.oneOfType([
      PropTypes.func,
      PropTypes.element,
    ]),
  };

  static defaultProps = {
    continuous: false,
    debug: false,
    disableCloseOnEsc: false,
    disableOverlay: false,
    disableOverlayClose: false,
    disableScrolling: false,
    hideBackButton: false,
    run: true,
    scrollOffset: 20,
    scrollToFirstStep: false,
    showSkipButton: false,
    showProgress: false,
    spotlightClicks: false,
    spotlightPadding: 10,
    steps: [],
  };

  componentDidMount() {
    if (!canUseDOM) return;

    const {
      debug,
      disableCloseOnEsc,
      run,
      steps,
    } = this.props;
    const { start } = this.store;

    log({
      title: 'init',
      data: [
        { key: 'props', value: this.props },
        { key: 'state', value: this.state },
      ],
      debug,
    });

    // Sync the store to this component state.
    this.store.addListener(this.syncState);

    if (validateSteps(steps, debug) && run) {
      start();
    }

    /* istanbul ignore else */
    if (!disableCloseOnEsc) {
      document.body.addEventListener('keydown', this.handleKeyboard, { passive: true });
    }
  }

  componentWillReceiveProps(nextProps) {
    if (!canUseDOM) return;
    const { action, status } = this.state;
    const { steps, stepIndex } = this.props;
    const { debug, run, steps: nextSteps, stepIndex: nextStepIndex } = nextProps;
    const { setSteps, start, stop, update } = this.store;
    const diffProps = !isEqual(this.props, nextProps);
    const { changed } = treeChanges(this.props, nextProps);

    if (diffProps) {
      log({
        title: 'props',
        data: [
          { key: 'nextProps', value: nextProps },
          { key: 'props', value: this.props },
        ],
        debug,
      });

      const stepsChanged = !isEqual(nextSteps, steps);
      const stepIndexChanged = is.number(nextStepIndex) && changed('stepIndex');
      let shouldStart = false;

      /* istanbul ignore else */
      if (changed('run')) {
        if (run) {
          shouldStart = true;
        }
        else {
          stop();
        }
      }
      if (shouldStart) {
        start();
      }

      if (stepsChanged) {
        if (validateSteps(nextSteps, debug)) {
          setSteps(nextSteps);
        }
        else {
          console.warn('Steps are not valid', nextSteps); //eslint-disable-line no-console
        }
      }

      /* istanbul ignore else */
      if (stepIndexChanged) {
        let nextAction = stepIndex < nextStepIndex ? ACTIONS.NEXT : ACTIONS.PREV;

        if (action === ACTIONS.STOP) {
          nextAction = ACTIONS.START;
        }

        if (![STATUS.FINISHED, STATUS.SKIPPED].includes(status)) {
          update({
            action: action === ACTIONS.CLOSE ? ACTIONS.CLOSE : nextAction,
            index: nextStepIndex,
            lifecycle: LIFECYCLE.INIT,
          });
        }
      }
    }
  }

  componentDidUpdate(prevProps, prevState) {
    if (!canUseDOM) return;

    const { index, lifecycle, status } = this.state;
    const { steps } = this.props;
    const step = getMergedStep(steps[index], this.props);
    const { changed, changedFrom, changedTo } = treeChanges(prevState, this.state);
    const diffState = !isEqual(prevState, this.state);

    if (diffState) {
      log({
        title: 'state',
        data: [
          { key: 'state', value: this.state },
          { key: 'changed', value: diffState },
          { key: 'step', value: step },
        ],
        debug: this.props.debug,
      });

      if (changed('status')) {
        let type = EVENTS.TOUR_STATUS;

        if (changedTo('status', STATUS.FINISHED) || changedTo('status', STATUS.SKIPPED)) {
          type = EVENTS.TOUR_END;
        }
        else if (changedFrom('status', STATUS.READY, STATUS.RUNNING)) {
          type = EVENTS.TOUR_START;
        }

        this.callback({
          ...this.state,
          step,
          type,
        });
      }

      if (step) {
        this.scrollToStep(prevState);

        if (step.placement === 'center' && status === STATUS.RUNNING && lifecycle === LIFECYCLE.INIT) {
          this.store.update({ lifecycle: LIFECYCLE.READY });
        }
      }

      if (changedTo('lifecycle', LIFECYCLE.INIT)) {
        delete this.beaconPopper;
        delete this.tooltipPopper;
      }
    }
  }

  componentWillUnmount() {
    const { disableCloseOnEsc } = this.props;

    /* istanbul ignore else */
    if (!disableCloseOnEsc) {
      document.body.removeEventListener('keydown', this.handleKeyboard);
    }
  }

  getScrollValue(step, target, axis) {
    const { lifecycle } = this.state;
    const { scrollOffset } = this.props;
    const hasCustomScroll = hasCustomScrollParent(target);
    let scrollValue = Math.floor(getScrollTo(target, scrollOffset, axis));

    const isYAxis = axis === 'y';
    const rectStart = isYAxis ? 'top' : 'left';
    const rectEnd = isYAxis ? 'bottom' : 'right';

    if (lifecycle === LIFECYCLE.BEACON && this.beaconPopper) {
      const { placement, popper } = this.beaconPopper;

      if (!hasCustomScroll && ![rectEnd].includes(placement)) {
        scrollValue = Math.floor(popper[rectStart] - scrollOffset);
      }
    }
    else if (lifecycle === LIFECYCLE.TOOLTIP && this.tooltipPopper) {
      const { flipped, placement, popper } = this.tooltipPopper;

      if (rectStart === placement && !flipped) {
        scrollValue = Math.floor(popper[rectStart] - scrollOffset);
      }
      else if (scrollValue - step.spotlightPadding >= 0) {
        scrollValue -= step.spotlightPadding;
      }
    }

    return scrollValue;
  }

  scrollToStep(prevState) {
    const { index, lifecycle, status } = this.state;
    const { debug, disableScrolling, scrollToFirstStep, steps } = this.props;
    const step = getMergedStep(steps[index], this.props);

    if (!step) {
      return;
    }

    const target = getElement(step.target);
    const scrollToStep = scrollToFirstStep || prevState.index !== index;
    const fixedStep = step.isFixed || isFixed(target);
    const lifecycleReady = prevState.lifecycle !== lifecycle && [LIFECYCLE.BEACON, LIFECYCLE.TOOLTIP].includes(lifecycle);

    const shouldScroll = !disableScrolling
      && !fixedStep // fixed steps don't need to scroll
      && lifecycleReady
      && scrollToStep;

    if (status === STATUS.RUNNING && shouldScroll) {
      const scrollParent = getScrollParent(target);
      const scrollY = this.getScrollValue(step, target, 'y');
      const scrollX = this.getScrollValue(step, target, 'x');

      log({
        title: 'scrollToStep',
        data: [
          { key: 'index', value: index },
          { key: 'lifecycle', value: lifecycle },
          { key: 'status', value: status },
        ],
        debug,
      });

      if (status === STATUS.RUNNING && shouldScroll) {
        const promises = [];

        if (scrollY >= 0) {
          promises.push(scrollTo(scrollY, scrollParent));
        }

        if (scrollX >= 0) {
          promises.push(scrollTo(scrollX, scrollParent, 'x'));
        }

        if (promises.length) {
          this.setState({ scrolling: true });

          Promise.all(promises).then(() => {
            this.setState({ scrolling: false });
          });
        }
      }
    }
  }

  /**
   * Trigger the callback.
   *
   * @private
   * @param {Object} data
   */
  callback = (data) => {
    const { callback } = this.props;

    /* istanbul ignore else */
    if (is.function(callback)) {
      callback(data);
    }
  };

  /**
   * Keydown event listener
   *
   * @private
   * @param {Event} e - Keyboard event
   */
  handleKeyboard = (e) => {
    const { index, lifecycle } = this.state;
    const { steps } = this.props;
    const step = steps[index];
    const intKey = window.Event ? e.which : e.keyCode;

    if (lifecycle === LIFECYCLE.TOOLTIP) {
      if (intKey === 27 && (step && !step.disableCloseOnEsc)) {
        this.store.close();
      }
    }
  };

  /**
   * Sync the store with the component's state
   *
   * @param {Object} state
   */
  syncState = (state) => {
    this.setState(state);
  };

  getPopper = (popper, type) => {
    if (type === 'wrapper') {
      this.beaconPopper = popper;
    }
    else {
      this.tooltipPopper = popper;
    }
  };

  render() {
    if (!canUseDOM) return null;

    const { index, status } = this.state;
    const { continuous, debug, disableScrolling, steps } = this.props;
    const step = getMergedStep(steps[index], this.props);
    let output;

    if (status === STATUS.RUNNING && step) {
      output = (
        <Step
          {...this.state}
          callback={this.callback}
          continuous={continuous}
          debug={debug}
          disableScrolling={disableScrolling}
          getPopper={this.getPopper}
          helpers={this.helpers}
          step={step}
          update={this.store.update}
        />
      );
    }

    return (
      <div className="joyride">
        {output}
      </div>
    );
  }
}

export default Joyride;
